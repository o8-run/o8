//! Composites annotation marks onto the attached image, off the paint thread.
//! Marks and text cards become one SVG layer that resvg draws over the decoded
//! pixels; the result is a PNG, or a JPEG when the PNG's data URI would pass
//! the server's 5 MB attachment cap.
use super::annotate::{COLORS, Shape};
use base64::Engine;
use resvg::{tiny_skia, usvg};
use std::{fmt::Write, io::Cursor, sync::Arc, sync::OnceLock};

/// The server drops a larger image data URI.
pub(crate) const MAX_DATA_URI: usize = 5_000_000;

/// A text card in image pixels.
pub(crate) struct Card {
    pub x: f32,
    pub y: f32,
    pub color: usize,
    pub text: String,
}

/// The arrowhead's two base corners: the desktop annotator's head and spread.
pub(crate) fn arrow_head(x1: f32, y1: f32, x2: f32, y2: f32, width: f32) -> [(f32, f32); 2] {
    let angle = (y2 - y1).atan2(x2 - x1);
    let head = (width * 4.).max(12.);
    let spread = std::f32::consts::PI / 7.;
    [
        (
            x2 - head * (angle - spread).cos(),
            y2 - head * (angle - spread).sin(),
        ),
        (
            x2 - head * (angle + spread).cos(),
            y2 - head * (angle + spread).sin(),
        ),
    ]
}

fn fonts() -> Arc<usvg::fontdb::Database> {
    static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
    FONTS
        .get_or_init(|| {
            let mut db = usvg::fontdb::Database::new();
            db.load_system_fonts();
            Arc::new(db)
        })
        .clone()
}

/// The first installed sans-serif family, as the desktop's system-ui stack.
fn sans(db: &usvg::fontdb::Database) -> String {
    const PREFERRED: [&str; 7] = [
        "SF Pro Text",
        "Helvetica Neue",
        "Helvetica",
        "Arial",
        "DejaVu Sans",
        "Liberation Sans",
        "Noto Sans",
    ];
    let installed = |name: &str| {
        db.faces()
            .any(|face| face.families.iter().any(|(family, _)| family == name))
    };
    PREFERRED
        .iter()
        .find(|name| installed(name))
        .map(|name| (*name).to_owned())
        .or_else(|| {
            db.faces()
                .find_map(|face| face.families.first().map(|(f, _)| f.clone()))
        })
        .unwrap_or_else(|| "sans-serif".into())
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn svg_document(width: f32, height: f32, body: &str) -> String {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">{body}</svg>"#
    )
}

fn shape_svg(out: &mut String, shape: &Shape) {
    let line = r#"fill="none" stroke-linecap="round" stroke-linejoin="round""#;
    match shape {
        Shape::Box {
            x1,
            y1,
            x2,
            y2,
            color,
            width,
        } => {
            let _ = write!(
                out,
                r#"<rect x="{}" y="{}" width="{}" height="{}" stroke="{}" stroke-width="{width}" {line}/>"#,
                x1.min(*x2),
                y1.min(*y2),
                (x2 - x1).abs(),
                (y2 - y1).abs(),
                COLORS[*color]
            );
        }
        Shape::Highlight {
            x1,
            y1,
            x2,
            y2,
            color,
        } => {
            let _ = write!(
                out,
                r#"<rect x="{}" y="{}" width="{}" height="{}" fill="{}" fill-opacity="0.3"/>"#,
                x1.min(*x2),
                y1.min(*y2),
                (x2 - x1).abs(),
                (y2 - y1).abs(),
                COLORS[*color]
            );
        }
        Shape::Arrow {
            x1,
            y1,
            x2,
            y2,
            color,
            width,
        } => {
            let [(ax, ay), (bx, by)] = arrow_head(*x1, *y1, *x2, *y2, *width);
            let color = COLORS[*color];
            let _ = write!(
                out,
                r#"<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" stroke-width="{width}" {line}/><polygon points="{x2},{y2} {ax},{ay} {bx},{by}" fill="{color}"/>"#
            );
        }
        Shape::Pen {
            points,
            color,
            width,
        } => {
            let points = points
                .iter()
                .map(|(x, y)| format!("{x},{y}"))
                .collect::<Vec<_>>()
                .join(" ");
            let _ = write!(
                out,
                r#"<polyline points="{points}" stroke="{}" stroke-width="{width}" {line}/>"#,
                COLORS[*color]
            );
        }
    }
}

/// A text card's look in image pixels, from the image width alone. The editor
/// draws its cards from the same numbers times the stage scale, so a note
/// bakes at exactly the size and place it showed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CardMetrics {
    pub font: f32,
    pub pad: f32,
    pub line_h: f32,
    pub radius: f32,
    pub border: f32,
}
pub(crate) fn card_metrics(image_width: f32) -> CardMetrics {
    let font = (image_width / 46.).round().max(20.);
    CardMetrics {
        font,
        pad: (font * 0.55).round(),
        line_h: (font * 1.32).round(),
        radius: (font * 0.35).round(),
        border: (font / 9.).round().max(2.),
    }
}
fn options() -> usvg::Options<'static> {
    let db = fonts();
    let mut options = usvg::Options {
        font_family: card_family(),
        ..usvg::Options::default()
    };
    options.fontdb = db;
    options
}
/// Loads the system fonts ahead of the first measure, off the paint thread.
pub(crate) fn warm_fonts() {
    card_family();
}
/// The family cards bake in; the editor draws its cards in it too.
pub(crate) fn card_family() -> String {
    static FAMILY: OnceLock<String> = OnceLock::new();
    FAMILY.get_or_init(|| sans(&fonts())).clone()
}
/// A card's box (width, height) in image pixels: the text's measured width
/// and its line count, plus padding. Blank text measures as one empty line.
pub(crate) fn card_size(text: &str, image_width: f32) -> (f32, f32) {
    let m = card_metrics(image_width);
    let text = text.trim_end();
    let lines = text.lines().count().max(1) as f32;
    let height = (lines * m.line_h + m.pad * 2.).round();
    // Blank needs no fonts, so a new card never waits on the font load.
    if text.trim().is_empty() {
        return ((1. + m.pad * 2.).round(), height);
    }
    let options = options();
    let card = Card {
        x: 0.,
        y: 0.,
        color: 0,
        text: text.to_owned(),
    };
    let svg = card_text(&card, &options.font_family, m.font, m.pad, m.line_h);
    let document = svg_document(image_width.max(1.), height, &svg);
    let measured = usvg::Tree::from_str(&document, &options)
        .map(|tree| tree.root().abs_bounding_box().width())
        .unwrap_or(0.)
        .max(1.);
    ((measured + m.pad * 2.).round(), height)
}

/// A card's text as SVG lines, at the card's top-left padding.
fn card_text(card: &Card, family: &str, font: f32, pad: f32, line_h: f32) -> String {
    let mut out = String::new();
    for (i, line) in card.text.lines().enumerate() {
        let _ = write!(
            out,
            r##"<text x="{}" y="{}" font-family="{}" font-size="{font}" font-weight="600" fill="#161616" xml:space="preserve">{}</text>"##,
            card.x + pad,
            // Alphabetic baseline: the line's top plus the font's ascent.
            card.y + pad + i as f32 * line_h + font * 0.8,
            escape(family),
            escape(line)
        );
    }
    out
}

/// Draws shapes and text cards over `bytes` and returns the new data URI.
pub(crate) fn composite(bytes: &[u8], shapes: &[Shape], cards: &[Card]) -> Result<String, String> {
    let decoded = image::load_from_memory(bytes).map_err(|_| "Could not decode the image.")?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    let size = tiny_skia::IntSize::from_wh(width, height).ok_or("The image is empty.")?;
    let mut data = rgba.into_raw();
    // tiny-skia stores premultiplied alpha.
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u16;
        for c in &mut px[..3] {
            *c = ((*c as u16 * a + 127) / 255) as u8;
        }
    }
    let mut pixmap = tiny_skia::Pixmap::from_vec(data, size).ok_or("The image is too large.")?;

    let options = options();
    let family = options.font_family.clone();
    let (w, h) = (width as f32, height as f32);
    let mut body = String::new();
    for shape in shapes {
        shape_svg(&mut body, shape);
    }
    // Cards match the desktop: a white rounded box, colored border, dark text.
    let CardMetrics {
        font,
        pad,
        line_h,
        radius,
        border,
    } = card_metrics(w);
    for card in cards.iter().filter(|c| !c.text.trim().is_empty()) {
        let card = Card {
            text: card.text.trim_end().to_owned(),
            ..*card
        };
        let text = card_text(&card, &family, font, pad, line_h);
        let (card_w, card_h) = card_size(&card.text, w);
        let _ = write!(
            body,
            r##"<rect x="{}" y="{}" width="{}" height="{}" rx="{radius}" fill="#ffffff" fill-opacity="0.96" stroke="{}" stroke-width="{border}"/>{text}"##,
            card.x, card.y, card_w, card_h, COLORS[card.color]
        );
    }
    let tree = usvg::Tree::from_str(&svg_document(w, h, &body), &options)
        .map_err(|_| "Could not draw the marks.")?;
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());

    let uri = |mime: &str, bytes: &[u8]| {
        format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    };
    let png = pixmap
        .encode_png()
        .map_err(|_| "Could not encode the image.")?;
    let png = uri("image/png", &png);
    if png.len() < MAX_DATA_URI {
        return Ok(png);
    }
    // Too large as PNG: JPEG at falling quality, as the desktop does.
    let rgb = image::RgbImage::from_fn(width, height, |x, y| {
        let p = pixmap.pixel(x, y).expect("in bounds").demultiply();
        image::Rgb([p.red(), p.green(), p.blue()])
    });
    for quality in [92, 80, 65, 50] {
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut jpeg), quality)
            .encode_image(&rgb)
            .map_err(|_| "Could not encode the image.")?;
        let jpeg = uri("image/jpeg", &jpeg);
        if jpeg.len() < MAX_DATA_URI {
            return Ok(jpeg);
        }
    }
    Err("The marked image is over 5 MB. Attach a smaller image.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([255, 255, 255, 255]));
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }
    fn decode(uri: &str) -> image::RgbaImage {
        let bytes = crate::composer::images::data_uri_bytes(uri).unwrap();
        image::load_from_memory(&bytes).unwrap().to_rgba8()
    }

    #[test]
    fn arrow_head_matches_the_desktop_geometry() {
        // Head max(12, 4 × width), spread π/7, pointing back along the shaft.
        let [(ax, ay), (bx, by)] = arrow_head(0., 0., 100., 0., 3.);
        let (dx, dy) = (
            12. * (std::f32::consts::PI / 7.).cos(),
            12. * (std::f32::consts::PI / 7.).sin(),
        );
        assert!(
            (ax - (100. - dx)).abs() < 1e-3 && (ay - dy).abs() < 1e-3,
            "{ax},{ay}"
        );
        assert!(
            (bx - (100. - dx)).abs() < 1e-3 && (by + dy).abs() < 1e-3,
            "{bx},{by}"
        );
        let [(ax, _), _] = arrow_head(0., 0., 100., 0., 6.);
        assert!((ax - (100. - 24. * (std::f32::consts::PI / 7.).cos())).abs() < 1e-3);
    }

    #[test]
    fn composite_draws_marks_and_a_text_card_into_a_png() {
        let shapes = [
            Shape::Box {
                x1: 50.,
                y1: 50.,
                x2: 150.,
                y2: 120.,
                color: 1,
                width: 6.,
            },
            Shape::Highlight {
                x1: 200.,
                y1: 20.,
                x2: 280.,
                y2: 80.,
                color: 2,
            },
        ];
        let cards = [Card {
            x: 20.,
            y: 140.,
            color: 3,
            text: "Fix this".into(),
        }];
        let uri = composite(&white(300, 220), &shapes, &cards).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
        let out = decode(&uri);
        assert_eq!(out.dimensions(), (300, 220));
        // Box edge: red (#EF4444).
        let edge = out.get_pixel(50, 85);
        assert!(edge[0] > 200 && edge[1] < 120, "{edge:?}");
        // Inside the box is untouched.
        assert_eq!(out.get_pixel(100, 85).0, [255, 255, 255, 255]);
        // Highlight: 30% blue (#3B82F6) over white.
        let tint = out.get_pixel(240, 50);
        assert!(tint[2] > 240 && tint[0] < 230 && tint[0] > 180, "{tint:?}");
        // The card's green border (#22C55E) starts at its corner.
        let border = out.get_pixel(30, 140);
        assert!(border[1] > border[0] + 60, "{border:?}");
        // With any font installed, the text darkens pixels inside the card.
        if fonts().len() > 0 {
            let dark = (25..120)
                .flat_map(|x| (150..175).map(move |y| (x, y)))
                .any(|(x, y)| out.get_pixel(x, y)[0] < 100);
            assert!(dark, "card text was not drawn");
        }
    }

    #[test]
    fn a_marked_image_over_the_cap_falls_back_to_jpeg() {
        // Noise does not compress: the PNG data URI passes 5 MB.
        let mut seed = 0x2545F491u32;
        let noise = image::RgbaImage::from_fn(1800, 1800, |_, _| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let [r, g, b, _] = seed.to_le_bytes();
            image::Rgba([r, g, b, 255])
        });
        let mut png = Vec::new();
        noise
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let shapes = [Shape::Arrow {
            x1: 10.,
            y1: 10.,
            x2: 600.,
            y2: 600.,
            color: 0,
            width: 6.,
        }];
        let uri = composite(&png, &shapes, &[]).unwrap();
        assert!(uri.starts_with("data:image/jpeg;base64,"), "{}", &uri[..30]);
        assert!(uri.len() < MAX_DATA_URI);
        assert_eq!(decode(&uri).dimensions(), (1800, 1800));
    }
}
