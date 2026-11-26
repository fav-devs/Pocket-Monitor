//! `pm://`: pictures for the web view that never cross JSON (§3.3, §3.5).
//!
//! An asynchronous URI scheme, so `<img src>` fetches are answered from the blocking
//! pool and never hold the main thread:
//!
//! - `pm://localhost/thumb/<camera path>`: the clip's `.scr` JPEG, from the cache or
//!   fetched once from the camera over `/v2` (one fetch at a time) and cached (U9).
//! - `pm://localhost/strip/<version>/<n>`: the player's filmstrip frame `n` as a PNG.
//! - `pm://localhost/file/<camera path>`: a cached original (stills; size-capped).
//!
//! On Windows (WebView2) Tauri serves the same scheme as `http://pm.localhost/…`; the
//! web side builds URLs with `convertFileSrc(path, 'pm')`, which knows which.

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder};

use crate::media::MediaService;
use crate::player::PlayerService;

/// A cached original larger than this is not served to the web view (a clip plays
/// through the native player, never an element).
const MOST_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Percent-decoding for one path segment set (`%2F` and friends).
pub fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What a `pm://` path asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Thumb(String),
    Strip(u32, usize),
    File(String),
}

pub fn route(path: &str) -> Option<Route> {
    let path = path.trim_start_matches('/');
    let (kind, rest) = path.split_once('/')?;
    match kind {
        "thumb" => Some(Route::Thumb(decode(rest)))
            .filter(|r| !matches!(r, Route::Thumb(p) if p.is_empty())),
        "file" => {
            Some(Route::File(decode(rest))).filter(|r| !matches!(r, Route::File(p) if p.is_empty()))
        }
        "strip" => {
            let (version, index) = rest.split_once('/')?;
            Some(Route::Strip(version.parse().ok()?, index.parse().ok()?))
        }
        _ => None,
    }
}

fn content_type(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".mp4") || lower.ends_with(".lrf") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}

fn respond(status: StatusCode, kind: &str, body: Vec<u8>, cache: bool) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::CACHE_CONTROL,
            if cache { "max-age=86400" } else { "no-store" },
        )
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn answer(app: &AppHandle, path: &str) -> Response<Vec<u8>> {
    let not_found = || {
        respond(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"not found".to_vec(),
            false,
        )
    };
    match route(path) {
        Some(Route::Thumb(id)) => match app.try_state::<MediaService>() {
            Some(media) => match media.thumb_bytes(&id) {
                Ok(bytes) => respond(StatusCode::OK, "image/jpeg", bytes, true),
                Err(reason) => respond(
                    StatusCode::NOT_FOUND,
                    "text/plain",
                    reason.into_bytes(),
                    false,
                ),
            },
            None => not_found(),
        },
        Some(Route::Strip(version, index)) => match app
            .try_state::<PlayerService>()
            .and_then(|player| player.strip_frame(version, index))
        {
            Some(png) => respond(StatusCode::OK, "image/png", png, true),
            None => not_found(),
        },
        Some(Route::File(id)) => {
            let Some(local) = app
                .try_state::<MediaService>()
                .and_then(|media| media.local_original(&id))
            else {
                return not_found();
            };
            let too_big =
                std::fs::metadata(&local).map_or(true, |meta| meta.len() > MOST_FILE_BYTES);
            if too_big {
                return respond(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "text/plain",
                    Vec::new(),
                    false,
                );
            }
            match std::fs::read(&local) {
                Ok(bytes) => respond(StatusCode::OK, content_type(&id), bytes, true),
                Err(_) => not_found(),
            }
        }
        None => not_found(),
    }
}

/// The scheme handler `main.rs` registers: every answer comes from the blocking pool.
pub fn handle(
    context: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let path = request.uri().path().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(answer(&app, &path));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_route_to_their_picture() {
        assert_eq!(
            route("/thumb/DCIM%2FDJI_001%2FDJI_1_D.MP4"),
            Some(Route::Thumb("DCIM/DJI_001/DJI_1_D.MP4".to_string()))
        );
        assert_eq!(route("/strip/3/7"), Some(Route::Strip(3, 7)));
        assert_eq!(
            route("/file/a%20b.JPG"),
            Some(Route::File("a b.JPG".to_string()))
        );
        assert_eq!(route("/thumb/"), None);
        assert_eq!(route("/strip/x/1"), None);
        assert_eq!(route("/other/1"), None);
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zz"), "%zz");
    }
}
