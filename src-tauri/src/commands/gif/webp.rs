use super::validate_frame_dimensions;

pub(super) fn inspect_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    let invalid = || "WebP 帧头部无效或不完整。".to_string();
    if data.get(..4) != Some(b"RIFF") || data.get(8..12) != Some(b"WEBP") {
        return Err(invalid());
    }
    let declared = u32::from_le_bytes(data[4..8].try_into().map_err(|_| invalid())?) as u64 + 8;
    if declared != data.len() as u64 {
        return Err(invalid());
    }
    let mut canvas = None;
    let mut image = None;
    let mut offset = 12usize;
    // image 0.24 的 WebP 构造器已经执行像素解码，必须在调用它之前检查所有尺寸。
    while offset < data.len() {
        let header = data.get(offset..offset + 8).ok_or_else(invalid)?;
        let length = u32::from_le_bytes(header[4..8].try_into().map_err(|_| invalid())?) as usize;
        let start = offset + 8;
        let end = start.checked_add(length).ok_or_else(invalid)?;
        let payload = data.get(start..end).ok_or_else(invalid)?;
        let dimensions = match &header[..4] {
            b"VP8X" => {
                if payload.len() != 10 || canvas.is_some() || image.is_some() {
                    return Err(invalid());
                }
                if payload[0] & 0x02 != 0 {
                    return Err("暂不支持动画 WebP 作为 GIF 单帧，请先转成静态图片。".into());
                }
                let width = u32::from_le_bytes([payload[4], payload[5], payload[6], 0]) + 1;
                let height = u32::from_le_bytes([payload[7], payload[8], payload[9], 0]) + 1;
                validate_frame_dimensions(width, height)?;
                canvas = Some((width, height));
                None
            }
            b"VP8 " => {
                if payload.len() < 10 || payload[3..6] != [0x9d, 0x01, 0x2a] {
                    return Err(invalid());
                }
                Some((
                    u32::from(u16::from_le_bytes([payload[6], payload[7]]) & 0x3fff),
                    u32::from(u16::from_le_bytes([payload[8], payload[9]]) & 0x3fff),
                ))
            }
            b"VP8L" => {
                if payload.len() < 5 || payload[0] != 0x2f {
                    return Err(invalid());
                }
                let bits = u32::from_le_bytes(payload[1..5].try_into().map_err(|_| invalid())?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"ANIM" | b"ANMF" => {
                return Err("暂不支持动画 WebP 作为 GIF 单帧，请先转成静态图片。".into());
            }
            _ => None,
        };
        if let Some(dimensions) = dimensions {
            validate_frame_dimensions(dimensions.0, dimensions.1)?;
            if image.replace(dimensions).is_some() || canvas.is_some_and(|size| size != dimensions)
            {
                return Err(invalid());
            }
        }
        offset = end.checked_add(length % 2).ok_or_else(invalid)?;
        if offset > data.len() {
            return Err(invalid());
        }
    }
    image.ok_or_else(invalid)
}
