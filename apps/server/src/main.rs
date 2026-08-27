#![forbid(unsafe_code)]

mod app;
mod hook;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    app::run().await
}
