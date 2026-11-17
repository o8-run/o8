// Verification child only. Match the exported Rust fixture clock without
// changing application clock behavior or accepting a caller-supplied clock.
if (process.env.NODE_ENV !== 'test') throw new Error('Fixture requires NODE_ENV=test');
Date.now = () => 1_798_128_000_000;
