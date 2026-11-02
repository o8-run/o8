use super::*;
impl Inspector {
    pub(super) fn detail_images(&mut self, cx: &mut Context<Self>) {
        let Some(detail) = &self.detail else {
            return;
        };
        crate::ui::images::load(
            self.client.clone(),
            &detail.rows,
            &detail.list,
            &detail.images,
            cx,
            |this, cache, changed, cx| {
                if let Some(detail) = &this.detail {
                    if std::rc::Rc::ptr_eq(cache, &detail.images)
                        && crate::ui::images::invalidate(&detail.rows, &detail.list, changed)
                    {
                        cx.notify();
                    }
                }
            },
            Self::detail_images,
        );
    }
    pub(super) fn load_older(&mut self, cx: &mut Context<Self>) {
        if self.detail_pending {
            return;
        }
        let Some((key, cursor)) = self.detail.as_ref().and_then(|d| {
            Some((
                d.key.clone()?,
                d.transcript
                    .as_ref()?
                    .page
                    .as_ref()
                    .filter(|p| p.has_more)?
                    .before_cursor
                    .clone()?,
            ))
        }) else {
            return;
        };
        self.detail_pending = true;
        self.detail_error = None;
        let (client, generation) = (self.client.clone(), self.generation);
        let expected = cursor.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.history_page(&key, Some(&cursor)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.detail_pending = false;
                let Some(detail) = this.detail.as_mut() else {
                    return;
                };
                if detail
                    .transcript
                    .as_ref()
                    .and_then(|t| t.page.as_ref())
                    .and_then(|p| p.before_cursor.as_ref())
                    != Some(&expected)
                {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(history) => {
                        detail.prepend(history);
                        this.detail_images(cx);
                    }
                    Err(error) => this.detail_error = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
}
