use std::{env, fs, path::PathBuf};
use minisign_verify::{PublicKey, Signature};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().collect();
    if args.len() != 4 {
        eprintln!("usage: verifier <public-key> <file> <signature>");
        std::process::exit(2);
    }
    let public_key = PublicKey::from_file(PathBuf::from(&args[1]))?;
    let signature = Signature::from_file(PathBuf::from(&args[3]))?;
    let content = fs::read(PathBuf::from(&args[2]))?;
    public_key.verify(&content, &signature, false)?;
    println!("Verified {}", PathBuf::from(&args[2]).display());
    Ok(())
}
