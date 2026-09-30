use libwebp_sys as webp;

const MAX_ICC_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn extract_static_icc(input: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let mut icc = None;
    inspect_static_webp(input, |fourcc, payload| {
        if fourcc == b"ICCP" {
            if icc.is_some() {
                return Err("stripSafe WebP input contains duplicate ICCP chunks".into());
            }
            validate_icc(payload)?;
            icc = Some(payload.to_vec());
        }
        Ok(())
    })?;
    Ok(icc)
}

pub(crate) fn apply_strip_safe(output: &[u8], icc: Option<&[u8]>) -> Result<Vec<u8>, String> {
    inspect_static_webp(output, |_, _| Ok(()))?;
    if let Some(icc) = icc {
        validate_icc(icc)?;
    }

    let input = webp::WebPData {
        bytes: output.as_ptr(),
        size: output.len(),
    };
    let mux = unsafe { webp::WebPMuxCreate(&input, 0) };
    if mux.is_null() {
        return Err("stripSafe WebP output could not initialize mux".into());
    }
    let mux = WebpMuxGuard(mux);
    for fourcc in [c"EXIF", c"XMP", c"ICCP"] {
        let result = unsafe { webp::WebPMuxDeleteChunk(mux.0, fourcc.as_ptr()) };
        if result != webp::WEBP_MUX_OK && result != webp::WEBP_MUX_NOT_FOUND {
            return Err("stripSafe WebP output could not remove metadata chunks".into());
        }
    }
    if let Some(icc) = icc {
        let data = webp::WebPData {
            bytes: icc.as_ptr(),
            size: icc.len(),
        };
        let result = unsafe { webp::WebPMuxSetChunk(mux.0, c"ICCP".as_ptr(), &data, 1) };
        if result != webp::WEBP_MUX_OK {
            return Err("stripSafe WebP output could not set ICCP chunk".into());
        }
    }

    let mut assembled = webp::WebPData {
        bytes: std::ptr::null(),
        size: 0,
    };
    let result = unsafe { webp::WebPMuxAssemble(mux.0, &mut assembled) };
    if result != webp::WEBP_MUX_OK {
        return Err("stripSafe WebP output could not assemble mux".into());
    }
    let assembled_guard = WebpDataGuard(&mut assembled);
    if assembled_guard.0.bytes.is_null() || assembled_guard.0.size == 0 {
        return Err("stripSafe WebP mux assembled an empty output".into());
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(assembled_guard.0.bytes, assembled_guard.0.size) };
    let assembled = bytes.to_vec();
    validate_static_webp_output(&assembled)?;
    Ok(assembled)
}

fn validate_static_webp_output(input: &[u8]) -> Result<(), String> {
    let mut iccp_count = 0;
    inspect_static_webp(input, |fourcc, payload| {
        match fourcc {
            b"VP8X" => {}
            b"ALPH" | b"VP8 " | b"VP8L" => {}
            b"ICCP" => {
                iccp_count += 1;
                validate_icc(payload)?;
            }
            _ => return Err("stripSafe WebP output contains a non-whitelisted chunk".into()),
        }
        Ok(())
    })?;
    if iccp_count > 1 {
        return Err("stripSafe WebP output contains duplicate ICCP chunks".into());
    }
    Ok(())
}

fn inspect_static_webp<F>(input: &[u8], mut visit: F) -> Result<(), String>
where
    F: FnMut(&[u8; 4], &[u8]) -> Result<(), String>,
{
    if input.len() < 12 || &input[..4] != b"RIFF" || &input[8..12] != b"WEBP" {
        return Err("stripSafe WebP input is missing a valid RIFF/WEBP header".into());
    }
    let riff_size = u32::from_le_bytes(input[4..8].try_into().unwrap()) as usize;
    let riff_end = 8usize
        .checked_add(riff_size)
        .ok_or_else(|| "stripSafe WebP RIFF size overflows".to_string())?;
    if riff_end != input.len() || riff_size < 4 {
        return Err("stripSafe WebP RIFF payload is truncated or has trailing bytes".into());
    }
    let mut offset = 12usize;
    let mut image_chunks = 0usize;
    let mut vp8x_chunks = 0usize;
    while offset < riff_end {
        let header_end = offset
            .checked_add(8)
            .ok_or_else(|| "stripSafe WebP chunk header overflows".to_string())?;
        if header_end > riff_end {
            return Err("stripSafe WebP chunk header is truncated".into());
        }
        let fourcc: &[u8; 4] = input[offset..offset + 4].try_into().unwrap();
        let payload_len =
            u32::from_le_bytes(input[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let payload_end = header_end
            .checked_add(payload_len)
            .ok_or_else(|| "stripSafe WebP chunk size overflows".to_string())?;
        let padded_end = payload_end
            .checked_add(usize::from(!payload_len.is_multiple_of(2)))
            .ok_or_else(|| "stripSafe WebP chunk padding overflows".to_string())?;
        if padded_end > riff_end {
            return Err("stripSafe WebP chunk or padding is truncated".into());
        }
        let payload = &input[header_end..payload_end];
        if !payload_len.is_multiple_of(2) && input[payload_end] != 0 {
            return Err("stripSafe WebP odd-sized chunk has a non-zero padding byte".into());
        }
        if *fourcc == *b"ANIM" || *fourcc == *b"ANMF" {
            return Err("metadataPolicy=stripSafe rejects animated WebP input".into());
        }
        if *fourcc == *b"VP8X" {
            vp8x_chunks += 1;
            if vp8x_chunks > 1 {
                return Err("stripSafe WebP input contains multiple VP8X chunks".into());
            }
            if payload_len < 1 {
                return Err("stripSafe WebP VP8X chunk is truncated".into());
            }
            if payload[0] & 0x02 != 0 {
                return Err("metadataPolicy=stripSafe rejects animated WebP input".into());
            }
        }
        if *fourcc == *b"VP8 " || *fourcc == *b"VP8L" {
            image_chunks += 1;
            if image_chunks > 1 {
                return Err("stripSafe WebP input contains multiple image chunks".into());
            }
        }
        visit(fourcc, payload)?;
        offset = padded_end;
    }
    if offset != riff_end || image_chunks != 1 {
        return Err("stripSafe WebP input is not a complete static image".into());
    }
    Ok(())
}

fn validate_icc(profile: &[u8]) -> Result<(), String> {
    if profile.len() > MAX_ICC_BYTES {
        return Err("stripSafe WebP ICCP payload exceeds the 4 MiB limit".into());
    }
    if profile.len() < 128
        || u32::from_be_bytes(profile[..4].try_into().unwrap()) as usize != profile.len()
        || &profile[36..40] != b"acsp"
    {
        return Err("stripSafe WebP ICCP payload has an invalid ICC structure".into());
    }
    Ok(())
}

struct WebpMuxGuard(*mut webp::WebPMux);

impl Drop for WebpMuxGuard {
    fn drop(&mut self) {
        unsafe { webp::WebPMuxDelete(self.0) };
    }
}

struct WebpDataGuard<'a>(&'a mut webp::WebPData);

impl Drop for WebpDataGuard<'_> {
    fn drop(&mut self) {
        unsafe { webp::WebPDataClear(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn riff(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let body_len = chunks
            .iter()
            .map(|(_, data)| 8 + data.len() + usize::from(!data.len().is_multiple_of(2)))
            .sum::<usize>();
        let mut out = Vec::from(*b"RIFF");
        out.extend_from_slice(&(4 + body_len as u32).to_le_bytes());
        out.extend_from_slice(b"WEBP");
        for (fourcc, data) in chunks {
            out.extend_from_slice(*fourcc);
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(data);
            if !data.len().is_multiple_of(2) {
                out.push(0);
            }
        }
        out
    }

    fn icc() -> Vec<u8> {
        let mut profile = vec![0; 128];
        profile[36..40].copy_from_slice(b"acsp");
        profile[..4].copy_from_slice(&(128u32.to_be_bytes()));
        profile
    }

    #[test]
    fn extracts_only_a_single_structurally_valid_iccp_from_static_webp() {
        let profile = icc();
        let input = riff(&[(b"VP8 ", b"pixels"), (b"ICCP", &profile)]);
        assert_eq!(extract_static_icc(&input).unwrap(), Some(profile));
    }

    #[test]
    fn rejects_animation_duplicate_iccp_and_truncated_padding() {
        let profile = icc();
        assert!(extract_static_icc(&riff(&[(b"ANIM", b"x"), (b"VP8 ", b"x")])).is_err());
        assert!(extract_static_icc(&riff(&[
            (b"VP8 ", b"x"),
            (b"ICCP", &profile),
            (b"ICCP", &profile)
        ]))
        .is_err());
        let mut truncated = riff(&[(b"VP8 ", b"x")]);
        truncated.pop();
        assert!(extract_static_icc(&truncated).is_err());
    }

    #[test]
    fn rejects_animation_bit_nonzero_padding_and_duplicate_vp8x() {
        assert!(extract_static_icc(&riff(&[(b"VP8X", &[0x02]), (b"VP8 ", b"x"),])).is_err());

        let mut bad_padding = riff(&[(b"VP8 ", b"x")]);
        *bad_padding.last_mut().unwrap() = 1;
        assert!(extract_static_icc(&bad_padding).is_err());

        assert!(
            extract_static_icc(&riff(&[(b"VP8X", &[0]), (b"VP8X", &[0]), (b"VP8 ", b"x"),]))
                .is_err()
        );
    }

    #[test]
    fn rejects_non_whitelisted_assembled_output() {
        let input = riff(&[(b"VP8 ", b"x"), (b"EXIF", b"private")]);
        assert!(validate_static_webp_output(&input).is_err());
    }

    #[test]
    fn accepts_alpha_chunk_in_static_webp_output() {
        let input = riff(&[(b"VP8X", &[0]), (b"ALPH", b"alpha"), (b"VP8 ", b"pixels")]);
        assert!(validate_static_webp_output(&input).is_ok());
    }
}
