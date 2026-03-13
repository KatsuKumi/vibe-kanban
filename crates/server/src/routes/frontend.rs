use axum::{
    body::Body,
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use reqwest::{StatusCode, header};
use rust_embed::RustEmbed;

const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

#[derive(RustEmbed)]
#[folder = "../../frontend/dist"]
pub struct Assets;

pub async fn serve_frontend(uri: axum::extract::Path<String>) -> impl IntoResponse {
    let path = uri.trim_start_matches('/');
    serve_file(path).await
}

pub async fn serve_frontend_root() -> impl IntoResponse {
    serve_file("index.html").await
}

fn is_hashed_asset(path: &str) -> bool {
    path.starts_with("assets/")
}

async fn serve_file(path: &str) -> impl IntoResponse + use<> {
    let file = Assets::get(path);

    match file {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            let cache_control = if is_hashed_asset(path) {
                IMMUTABLE_CACHE
            } else {
                NO_CACHE
            };

            Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref()).unwrap(),
                )
                .header(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static(cache_control),
                )
                .body(Body::from(content.data.into_owned()))
                .unwrap()
        }
        None => {
            if let Some(index) = Assets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, HeaderValue::from_static("text/html"))
                    .header(
                        header::CACHE_CONTROL,
                        HeaderValue::from_static(NO_CACHE),
                    )
                    .body(Body::from(index.data.into_owned()))
                    .unwrap()
            } else {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("404 Not Found"))
                    .unwrap()
            }
        }
    }
}
