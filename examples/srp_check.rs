//! SRP Client example for testing the authentication flow

use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use srp::client::SrpClient;
use srp::groups::G_2048;
use srp::server::SrpServer;

fn main() {
    println!("SRP Authentication Test");

    // 1. Client generates credentials (registration)
    let username = b"testuser";
    let password = b"password123";

    let client = SrpClient::<Sha256>::new(&G_2048);

    // Generate salt
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);

    // Compute verifier (stored on server)
    let verifier = client.compute_verifier(username, password, &salt);
    println!("Verifier computed: {} bytes", verifier.len());

    // 2. Server initialization
    let server = SrpServer::<Sha256>::new(&G_2048);

    // 3. Client generates A (ephemeral public)
    let mut a_private = [0u8; 64];
    OsRng.fill_bytes(&mut a_private);
    let a_pub = client.compute_public_ephemeral(&a_private);
    println!("Client A: {} bytes", a_pub.len());

    // 4. Server generates B (ephemeral public)
    let mut b_private = [0u8; 64];
    OsRng.fill_bytes(&mut b_private);
    let b_pub = server.compute_public_ephemeral(&b_private, &verifier);
    println!("Server B: {} bytes", b_pub.len());

    // 5. Client computes session key and proof M1
    let client_verifier = client
        .process_reply(&a_private, username, password, &salt, &b_pub)
        .expect("Client process_reply failed");

    let m1_proof = client_verifier.proof();
    println!("Client M1 proof: {} bytes", m1_proof.len());

    // 6. Server verifies M1 and computes M2
    let server_verifier = server
        .process_reply(&b_private, &verifier, &a_pub)
        .expect("Server process_reply failed");

    server_verifier
        .verify_client(m1_proof)
        .expect("M1 verification failed");
    let m2_proof = server_verifier.proof();
    println!("Server M2 proof: {} bytes", m2_proof.len());

    // 7. Client verifies M2
    client_verifier
        .verify_server(m2_proof)
        .expect("M2 verification failed");

    println!("\n✓ SRP handshake completed successfully!");
    println!(
        "Session key established: {} bytes",
        server_verifier.key().len()
    );
}
