#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, FromRow, Serialize, Deserialize)]
pub struct User {
    pub id: Option<i64>,
    pub username: Option<String>,
    pub salt: Option<Vec<u8>>,
    pub verifier: Option<Vec<u8>>,
    pub created_at: Option<chrono::NaiveDateTime>,
}

#[derive(Debug, FromRow)]
pub struct LoginAttempt {
    pub username: String,
    pub b_secret: Vec<u8>,
    pub a_pub: Vec<u8>, // Added this
    pub timestamp: Option<chrono::NaiveDateTime>,
}
