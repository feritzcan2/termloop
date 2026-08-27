#![forbid(unsafe_code)]

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    termloop_companion::run_from_environment().await?;
    Ok(())
}
