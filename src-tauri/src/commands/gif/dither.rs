#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DitherMode {
    None,
    FloydSteinberg,
    Atkinson,
}

impl DitherMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "none" => Ok(Self::None),
            "floydSteinberg" => Ok(Self::FloydSteinberg),
            "atkinson" => Ok(Self::Atkinson),
            _ => Err("GIF 抖动方式必须为 none、floydSteinberg 或 atkinson。".to_string()),
        }
    }
}

pub fn quantize_rgba(
    pixels: &[u8],
    width: u32,
    height: u32,
    palette: &[u8],
    mode: DitherMode,
) -> Vec<u8> {
    if mode == DitherMode::None {
        return pixels
            .chunks_exact(4)
            .map(|pixel| nearest_color(pixel[0], pixel[1], pixel[2], palette))
            .collect();
    }

    let mut work = pixels
        .chunks_exact(4)
        .map(|pixel| [pixel[0] as f32, pixel[1] as f32, pixel[2] as f32])
        .collect::<Vec<_>>();
    let mut indexed = Vec::with_capacity(work.len());
    let width = width as usize;
    let height = height as usize;
    for y in 0..height {
        for x in 0..width {
            let offset = y * width + x;
            let [r, g, b] = work[offset];
            let index = nearest_color(r as u8, g as u8, b as u8, palette);
            indexed.push(index);
            let base = index as usize * 3;
            let error = [
                r - palette[base] as f32,
                g - palette[base + 1] as f32,
                b - palette[base + 2] as f32,
            ];
            diffuse(&mut work, width, height, x, y, error, mode);
        }
    }
    indexed
}

fn nearest_color(r: u8, g: u8, b: u8, palette: &[u8]) -> u8 {
    let mut best = 0;
    let mut distance = f32::MAX;
    for (index, color) in palette.chunks_exact(3).enumerate() {
        let dr = r as f32 - color[0] as f32;
        let dg = g as f32 - color[1] as f32;
        let db = b as f32 - color[2] as f32;
        let current = dr * dr + dg * dg + db * db;
        if current < distance {
            distance = current;
            best = index as u8;
        }
    }
    best
}

fn diffuse(
    pixels: &mut [[f32; 3]],
    width: usize,
    height: usize,
    x: usize,
    y: usize,
    error: [f32; 3],
    mode: DitherMode,
) {
    let kernel: &[(isize, isize, f32)] = match mode {
        DitherMode::FloydSteinberg => &[
            (1, 0, 7.0 / 16.0),
            (-1, 1, 3.0 / 16.0),
            (0, 1, 5.0 / 16.0),
            (1, 1, 1.0 / 16.0),
        ],
        DitherMode::Atkinson => &[
            (1, 0, 1.0 / 8.0),
            (2, 0, 1.0 / 8.0),
            (-1, 1, 1.0 / 8.0),
            (0, 1, 1.0 / 8.0),
            (1, 1, 1.0 / 8.0),
            (0, 2, 1.0 / 8.0),
        ],
        DitherMode::None => return,
    };
    for &(dx, dy, weight) in kernel {
        let nx = x as isize + dx;
        let ny = y as isize + dy;
        if nx >= 0 && ny >= 0 && (nx as usize) < width && (ny as usize) < height {
            let target = &mut pixels[ny as usize * width + nx as usize];
            for channel in 0..3 {
                target[channel] = (target[channel] + error[channel] * weight).clamp(0.0, 255.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_modes_and_rejects_unknown_values() {
        assert_eq!(DitherMode::parse("none").unwrap(), DitherMode::None);
        assert_eq!(
            DitherMode::parse("floydSteinberg").unwrap(),
            DitherMode::FloydSteinberg
        );
        assert_eq!(DitherMode::parse("atkinson").unwrap(), DitherMode::Atkinson);
        assert!(DitherMode::parse("ordered").is_err());
    }

    #[test]
    fn all_modes_return_palette_indices_without_changing_pixel_count() {
        let pixels = [
            64, 64, 64, 255, 192, 192, 192, 255, 128, 128, 128, 255, 32, 32, 32, 255,
        ];
        let palette = [0, 0, 0, 255, 255, 255];
        for mode in [
            DitherMode::None,
            DitherMode::FloydSteinberg,
            DitherMode::Atkinson,
        ] {
            let indexed = quantize_rgba(&pixels, 4, 1, &palette, mode);
            assert_eq!(indexed.len(), 4);
            assert!(indexed.iter().all(|index| *index < 2));
        }
    }
}
