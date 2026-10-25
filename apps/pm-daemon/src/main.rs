#![forbid(unsafe_code)]

mod app;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    app::run().await
}
