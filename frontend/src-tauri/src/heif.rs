//! HEIC/HEIF photo -> JPEG, in memory, through Windows Imaging Component.
//!
//! WebView2 (Chromium) cannot decode HEIC, the format most phone cameras
//! save, so a HEIC sent to a channel was a broken picture in this app
//! (owner report 2026-10-23). The page asks for a JPEG instead
//! (frontend/src/api/heif.ts): before it encrypts one for upload, and to show
//! one someone already sent. Windows decodes HEIF through WIC once the "HEIF
//! Image Extensions" and "HEVC Video Extensions" from the Microsoft Store are
//! installed; without them `CreateDecoderFromStream` fails, this returns an
//! error, and the page falls back (it sends the original, or shows the file
//! as a download).
//!
//! The bytes arrive and leave as raw IPC bodies and never touch the disk: WIC
//! reads them from an `IWICStream` over this memory and writes the JPEG into
//! a memory stream (`SHCreateMemStream`). The JPEG carries NO metadata: the
//! encoder is handed decoded pixels only, so the location, camera and time a
//! phone stores in the HEIC are not copied. The HEIF rotation (`irot`/`imir`)
//! is applied by WIC's HEIF decoder itself — measured with a HEIC stored
//! 64x48 with a 90-degree `irot`: the frame came back 48x64, the right way
//! up, and `/heifProps/Orientation` then read 1 — so nothing here rotates it
//! again.

use tauri::ipc::{InvokeBody, Request, Response};

/// The longest edge of the JPEG, unless the page asks for less.
const DEFAULT_MAX_EDGE: u32 = 4096;
/// Refuse a picture this large (decoded, 4 bytes a pixel, ~400 MB): a phone
/// photo is 12-50 MP; anything bigger is not one, or is a decompression bomb.
const MAX_PIXELS: u64 = 100_000_000;
/// The upload cap is 25 MB; leave room, refuse anything far past it.
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;

/// The size `w`x`h` scales to so its long edge is at most `max_edge`.
pub(crate) fn fit_within(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= max_edge || long == 0 {
        return (w, h);
    }
    let k = max_edge as f64 / long as f64;
    (((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1))
}

/// JPEG bytes for a HEIC/HEIF photo. Raw IPC body in, raw bytes out; headers
/// `x-max-edge` (pixels) and `x-quality` (0..1) are optional.
#[tauri::command]
pub async fn heif_to_jpeg(request: Request<'_>) -> Result<Response, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("expected a raw body".into()),
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let max_edge = header("x-max-edge").and_then(|v| v.parse::<u32>().ok()).filter(|&e| (16..=16384).contains(&e)).unwrap_or(DEFAULT_MAX_EDGE);
    let quality = header("x-quality").and_then(|v| v.parse::<f32>().ok()).filter(|q| (0.1..=1.0).contains(q)).unwrap_or(0.9);
    let jpeg = tauri::async_runtime::spawn_blocking(move || convert(&bytes, max_edge, quality))
        .await
        .map_err(|e| format!("conversion task failed: {e}"))??;
    Ok(Response::new(jpeg))
}

#[cfg(windows)]
pub(crate) fn convert(bytes: &[u8], max_edge: u32, quality: f32) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err("not a photo this can convert".into());
    }
    // COM for this thread (a blocking-pool thread: initialised once and kept,
    // which is what COM expects of a thread that keeps doing COM work).
    let _ = unsafe { windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED) };
    wic::convert(bytes, max_edge, quality).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub(crate) fn convert(_bytes: &[u8], _max_edge: u32, _quality: f32) -> Result<Vec<u8>, String> {
    Err("HEIF conversion is only built for Windows".into())
}

#[cfg(windows)]
mod wic {
    use super::{fit_within, MAX_PIXELS};
    use windows::core::{Error, Result, HSTRING, VARIANT};
    use windows::Win32::Foundation::E_INVALIDARG;
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::StructuredStorage::{IPropertyBag2, PROPBAG2};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER, STREAM_SEEK_END, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    /// The WIC container GUID of HEIF (GUID_ContainerFormatHeif).
    const CONTAINER_HEIF: windows::core::GUID = GUID_ContainerFormatHeif;

    pub(super) fn convert(bytes: &[u8], max_edge: u32, quality: f32) -> Result<Vec<u8>> {
        unsafe {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let input = factory.CreateStream()?;
            input.InitializeFromMemory(bytes)?;
            // Fails with WINCODEC_ERR_COMPONENTNOTFOUND when the HEIF/HEVC
            // extensions are not installed: the page falls back.
            let decoder = factory.CreateDecoderFromStream(&input, std::ptr::null(), WICDecodeMetadataCacheOnDemand)?;
            // Only a HEIF: this is not a general image converter.
            if decoder.GetContainerFormat()? != CONTAINER_HEIF {
                return Err(Error::new(E_INVALIDARG, "not a HEIF image"));
            }
            let frame = decoder.GetFrame(0)?;
            let (mut w, mut h) = (0u32, 0u32);
            frame.GetSize(&mut w, &mut h)?;
            if w == 0 || h == 0 || (w as u64) * (h as u64) > MAX_PIXELS {
                return Err(Error::new(E_INVALIDARG, "picture too large"));
            }
            let (tw, th) = fit_within(w, h, max_edge);
            let source: IWICBitmapSource = if (tw, th) != (w, h) {
                let scaler = factory.CreateBitmapScaler()?;
                scaler.Initialize(&frame, tw, th, WICBitmapInterpolationModeHighQualityCubic)?;
                scaler.into()
            } else {
                frame.into()
            };
            let pixels = factory.CreateFormatConverter()?;
            pixels.Initialize(&source, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom)?;

            let out = SHCreateMemStream(None).ok_or_else(|| Error::new(E_INVALIDARG, "no memory stream"))?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())?;
            encoder.Initialize(&out, WICBitmapEncoderNoCache)?;
            let mut target = None;
            let mut options: Option<IPropertyBag2> = None;
            encoder.CreateNewFrame(&mut target, &mut options)?;
            let target = target.ok_or_else(|| Error::new(E_INVALIDARG, "no JPEG frame"))?;
            if let Some(bag) = &options {
                let name = HSTRING::from("ImageQuality");
                let prop = PROPBAG2 { pstrName: windows::core::PWSTR(name.as_ptr() as *mut u16), ..Default::default() };
                bag.Write(1, &prop, &VARIANT::from(quality))?;
            }
            target.Initialize(options.as_ref())?;
            target.SetSize(tw, th)?;
            let mut format = GUID_WICPixelFormat24bppBGR;
            target.SetPixelFormat(&mut format)?;
            // Pixels only: no metadata writer, no thumbnail, no color context
            // copied from the source.
            target.WriteSource(&pixels, std::ptr::null())?;
            target.Commit()?;
            encoder.Commit()?;

            let mut size = 0u64;
            out.Seek(0, STREAM_SEEK_END, Some(&mut size))?;
            out.Seek(0, STREAM_SEEK_SET, None)?;
            let mut jpeg = vec![0u8; size as usize];
            let mut read = 0u32;
            out.Read(jpeg.as_mut_ptr().cast(), size as u32, Some(&mut read)).ok()?;
            jpeg.truncate(read as usize);
            Ok(jpeg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_within_keeps_small_and_scales_the_long_edge() {
        assert_eq!(fit_within(4000, 3000, 4096), (4000, 3000));
        assert_eq!(fit_within(8160, 6120, 4096), (4096, 3072));
        assert_eq!(fit_within(6120, 8160, 4096), (3072, 4096));
        assert_eq!(fit_within(10000, 1, 4096), (4096, 1));
        assert_eq!(fit_within(0, 0, 4096), (0, 0));
    }

    /// The fixture: 64x48 stored, a 90-degree `irot`, so it shows 48x64 with
    /// blue top-left, red top-right, white bottom-left, green bottom-right;
    /// its EXIF names a camera ("PucaTestCam") and a GPS position. Made with
    /// libheif (pillow-heif) for these tests; frontend/src/tests/fixtures.
    #[cfg(windows)]
    const FIXTURE: &[u8] = include_bytes!("../../src/tests/fixtures/heic/rotated-gps.heic");

    /// Decoded size and the colour near each corner (r, g, b) of a JPEG,
    /// through WIC as well (its JPEG decoder is built in).
    #[cfg(windows)]
    fn corners(jpeg: &[u8]) -> ((u32, u32), [(u8, u8, u8); 4]) {
        use windows::Win32::Graphics::Imaging::*;
        use windows::Win32::System::Com::*;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let f: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let s = f.CreateStream().unwrap();
            s.InitializeFromMemory(jpeg).unwrap();
            let d = f.CreateDecoderFromStream(&s, std::ptr::null(), WICDecodeMetadataCacheOnDemand).unwrap();
            assert_eq!(d.GetContainerFormat().unwrap(), GUID_ContainerFormatJpeg);
            let fr = d.GetFrame(0).unwrap();
            let (mut w, mut h) = (0, 0);
            fr.GetSize(&mut w, &mut h).unwrap();
            let c = f.CreateFormatConverter().unwrap();
            c.Initialize(&fr, &GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, None, 0.0, WICBitmapPaletteTypeCustom).unwrap();
            let stride = w * 3;
            let mut px = vec![0u8; (stride * h) as usize];
            c.CopyPixels(std::ptr::null(), stride, &mut px).unwrap();
            let at = |x: u32, y: u32| {
                let i = (y * stride + x * 3) as usize;
                (px[i + 2], px[i + 1], px[i])
            };
            ((w, h), [at(4, 4), at(w - 5, 4), at(4, h - 5), at(w - 5, h - 5)])
        }
    }

    #[cfg(windows)]
    fn near(c: (u8, u8, u8), want: (u8, u8, u8)) -> bool {
        (c.0 as i32 - want.0 as i32).abs() < 60 && (c.1 as i32 - want.1 as i32).abs() < 60 && (c.2 as i32 - want.2 as i32).abs() < 60
    }

    /// Whether this machine can decode HEIF at all (the Store extensions),
    /// asked of WIC directly, NOT through `convert`: a CI runner usually
    /// cannot, and the test then says SKIP; but a `convert` that fails on a
    /// machine that CAN decode is a failure, never a skip.
    #[cfg(windows)]
    fn heif_decoder_installed() -> bool {
        use windows::Win32::Graphics::Imaging::*;
        use windows::Win32::System::Com::*;
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let f: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).unwrap();
            let s = f.CreateStream().unwrap();
            s.InitializeFromMemory(FIXTURE).unwrap();
            match f.CreateDecoderFromStream(&s, std::ptr::null(), WICDecodeMetadataCacheOnDemand).and_then(|d| d.GetFrame(0)) {
                Ok(_) => true,
                Err(e) if e.code() == windows::Win32::Foundation::WINCODEC_ERR_COMPONENTNOTFOUND => {
                    eprintln!("SKIP: no HEIF decoder on this machine (install the HEIF and HEVC extensions)");
                    false
                }
                Err(e) => panic!("WIC refused the fixture for another reason: {e}"),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn converts_the_fixture_upright_with_no_metadata() {
        if !heif_decoder_installed() {
            return;
        }
        let jpeg = convert(FIXTURE, 4096, 0.9).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8], "a JPEG");
        let ((w, h), [tl, tr, bl, br]) = corners(&jpeg);
        // The right way up: the irot applied, once.
        assert_eq!((w, h), (48, 64));
        assert!(near(tl, (30, 30, 220)), "top-left blue, got {tl:?}");
        assert!(near(tr, (220, 30, 30)), "top-right red, got {tr:?}");
        assert!(near(bl, (240, 240, 240)), "bottom-left white, got {bl:?}");
        assert!(near(br, (30, 200, 30)), "bottom-right green, got {br:?}");
        // Nothing of the original's metadata: no Exif block at all, and
        // neither the camera's name nor the GPS reference letters.
        let has = |needle: &[u8]| jpeg.windows(needle.len()).any(|w| w == needle);
        assert!(has(b"PucaTestCam") == false && has(b"Exif\0\0") == false, "metadata copied into the JPEG");
        // Control: the fixture does carry them.
        let fixture_has = |needle: &[u8]| FIXTURE.windows(needle.len()).any(|w| w == needle);
        assert!(fixture_has(b"PucaTestCam") && fixture_has(b"Exif\0\0"));
    }

    #[cfg(windows)]
    #[test]
    fn scales_down_to_the_edge_asked_for() {
        if !heif_decoder_installed() {
            return;
        }
        let ((w, h), _) = corners(&convert(FIXTURE, 32, 0.9).unwrap());
        assert_eq!((w, h), (24, 32));
    }

    #[cfg(windows)]
    #[test]
    fn refuses_what_is_not_a_heif() {
        assert!(convert(b"not a picture at all", 4096, 0.9).is_err());
        assert!(convert(&[], 4096, 0.9).is_err());
        if !heif_decoder_installed() {
            return;
        }
        // A JPEG decodes fine through WIC, but this converts HEIF only.
        let jpeg = convert(FIXTURE, 4096, 0.9).unwrap();
        assert!(convert(&jpeg, 4096, 0.9).is_err());
    }
}
