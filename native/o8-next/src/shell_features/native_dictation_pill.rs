use super::*;
struct NativeDictationPill;
register_shell_feature!(NativeDictationPill);
impl ShellFeature for NativeDictationPill {
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 200,
            install: |_, _, cx| crate::native_pill::install(cx),
        }]
    }
}
