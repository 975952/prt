// Frozen lettering keeps the selected book-spine artwork independent of installed fonts.
const ART: &[u8; 256 * 256 * 4] = include_bytes!("../assets/book-spine.rgba");

pub fn render_icon_rgba(size: u32) -> Vec<u8> {
    assert!((1..=256).contains(&size));
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let mut rgb = [0u32; 3];
            let mut alpha = 0;
            let mut count = 0;
            for row in y * 256 / size..(y + 1) * 256 / size {
                for col in x * 256 / size..(x + 1) * 256 / size {
                    let i = ((row * 256 + col) * 4) as usize;
                    let a = u32::from(ART[i + 3]);
                    for c in 0..3 { rgb[c] += u32::from(ART[i + c]) * a; }
                    alpha += a;
                    count += 1;
                }
            }
            pixels.extend(rgb.map(|v| (v / alpha.max(1)) as u8));
            pixels.push((alpha / count) as u8);
        }
    }
    pixels
}
