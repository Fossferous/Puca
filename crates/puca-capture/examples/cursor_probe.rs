//! Visual proof that the host pointer is drawn in the right place, the right
//! way up, on every output — including rotated ones.
//!
//! `cargo run --example cursor_probe -- <output-dir>` parks the pointer at the
//! centre of each screen in turn and dumps a small BMP crop of the middle of
//! the captured frame. The cursor must appear at the CENTRE of every crop and
//! be upright. Convert and view with:
//!
//! ```powershell
//! Add-Type -AssemblyName System.Drawing
//! $i = [System.Drawing.Image]::FromFile("cursor1.bmp")
//! (New-Object System.Drawing.Bitmap($i, 288, 288)).Save("cursor1.png", "Png")
//! ```
//!
//! This exists because the unit tests can only prove the BLENDING is right.
//! Whether DXGI reports the pointer in panel or desktop coordinates is not
//! something a test can assert without a rotated monitor attached, and getting
//! it wrong puts a perfectly drawn cursor a thousand pixels from the mouse.
use puca_capture::{outputs, ScreenCapture};

#[link(name = "user32")]
extern "system" {
    fn SetCursorPos(x: i32, y: i32) -> i32;
}

fn main() {
    let outs = outputs();
    for o in &outs {
        // Put the pointer at the middle of THIS output, in desktop coordinates.
        let cx = o.left + o.width as i32 / 2;
        let cy = o.top + o.height as i32 / 2;
        unsafe {
            SetCursorPos(cx, cy);
        }
        std::thread::sleep(std::time::Duration::from_millis(300));

        let Ok(mut cap) = ScreenCapture::new(o.index) else {
            println!("[{}] could not open", o.index);
            continue;
        };
        let mut frame = None;
        for _ in 0..40 {
            if let Ok(f) = cap.next_frame(120) {
                frame = Some(f);
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let Some(f) = frame else {
            println!("[{}] no frame", o.index);
            continue;
        };

        // The pointer should be at the centre of the frame, since that is where
        // we put it in desktop space and the frame is in desktop orientation.
        let (fx, fy) = (f.width as i32 / 2, f.height as i32 / 2);
        let side = 72i32;
        let (x0, y0) = ((fx - side / 2).max(0), (fy - side / 2).max(0));
        let w = side.min(f.width as i32 - x0) as usize;
        let h = side.min(f.height as i32 - y0) as usize;

        let row = ((w * 3) + 3) & !3;
        let mut px = vec![0u8; row * h];
        for y in 0..h {
            for x in 0..w {
                let s = (y0 as usize + y) * f.stride + (x0 as usize + x) * 4;
                let d = (h - 1 - y) * row + x * 3;
                px[d..d + 3].copy_from_slice(&f.bgra[s..s + 3]);
            }
        }
        let mut bmp = Vec::new();
        let size = 54 + px.len();
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&(size as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&(w as i32).to_le_bytes());
        bmp.extend_from_slice(&(h as i32).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&24u16.to_le_bytes());
        bmp.extend_from_slice(&[0; 24]);
        bmp.extend_from_slice(&px);
        let path = format!("{}/cursor{}.bmp", std::env::args().nth(1).unwrap(), o.index);
        std::fs::write(&path, &bmp).unwrap();
        println!(
            "[{}] {}x{} rot={:?} -> {} (arrow should sit at the CENTRE, upright)",
            o.index, f.width, f.height, o.rotation, path
        );
    }
}
