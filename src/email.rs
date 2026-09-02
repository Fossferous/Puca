//! Email service for sending verification and password reset emails

use lettre::{
    message::header::ContentType, transport::smtp::authentication::Credentials, AsyncSmtpTransport,
    AsyncTransport, Message, Tokio1Executor,
};
use std::env;

/// Email configuration from environment
#[derive(Clone)]
pub struct EmailConfig {
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    pub from_email: String,
    pub app_url: String,
}

impl EmailConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Option<Self> {
        let smtp_host = env::var("SMTP_HOST").ok()?;
        let smtp_port = env::var("SMTP_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(587);
        let smtp_username = env::var("SMTP_USERNAME").ok()?;
        let smtp_password = env::var("SMTP_PASSWORD").ok()?;
        let from_email = env::var("SMTP_FROM").ok()?;
        let app_url = env::var("APP_URL").unwrap_or_else(|_| "http://localhost:5173".to_string());

        Some(Self {
            smtp_host,
            smtp_port,
            smtp_username,
            smtp_password,
            from_email,
            app_url,
        })
    }
}

/// Email service for sending emails
#[derive(Clone)]
pub struct EmailService {
    config: EmailConfig,
}

impl EmailService {
    pub fn new(config: EmailConfig) -> Self {
        Self { config }
    }

    /// Create SMTP transport
    fn create_transport(&self) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
        let creds = Credentials::new(
            self.config.smtp_username.clone(),
            self.config.smtp_password.clone(),
        );

        Ok(
            AsyncSmtpTransport::<Tokio1Executor>::relay(&self.config.smtp_host)
                .map_err(|e| format!("Failed to create SMTP transport: {}", e))?
                .port(self.config.smtp_port)
                .credentials(creds)
                .build(),
        )
    }

    /// Send email verification link
    pub async fn send_verification_email(
        &self,
        to_email: &str,
        username: &str,
        token: &str,
    ) -> Result<(), String> {
        let verification_url = format!("{}/verify-email?token={}", self.config.app_url, token);

        let html_body = format!(
            r#"
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {{ font-family: 'Segoe UI', Arial, sans-serif; background: #1e1f22; color: #dbdee1; padding: 20px; }}
                    .container {{ max-width: 600px; margin: 0 auto; background: #2b2d31; border-radius: 8px; padding: 30px; }}
                    h1 {{ color: #f2f3f5; }}
                    .button {{ display: inline-block; background: #5865f2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600; }}
                    .button:hover {{ background: #4752c4; }}
                    .footer {{ margin-top: 20px; font-size: 12px; color: #949ba4; }}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Verify Your Email</h1>
                    <p>Hi {username},</p>
                    <p>Thanks for registering! Please verify your email address by clicking the button below:</p>
                    <p><a href="{verification_url}" class="button">Verify Email</a></p>
                    <p>Or copy this link: {verification_url}</p>
                    <p class="footer">This link expires in 24 hours. If you didn't create an account, you can ignore this email.</p>
                </div>
            </body>
            </html>
            "#,
            username = username,
            verification_url = verification_url
        );

        let email = Message::builder()
            .from(
                self.config
                    .from_email
                    .parse()
                    .map_err(|e| format!("Invalid from email: {}", e))?,
            )
            .to(to_email
                .parse()
                .map_err(|e| format!("Invalid to email: {}", e))?)
            .subject("Verify your Puca email")
            .header(ContentType::TEXT_HTML)
            .body(html_body)
            .map_err(|e| format!("Failed to build email: {}", e))?;

        let transport = self.create_transport()?;
        transport
            .send(email)
            .await
            .map_err(|e| format!("Failed to send email: {}", e))?;

        tracing::info!("Verification email sent (domain {})", crate::logtag::mail_domain(&to_email));
        Ok(())
    }

    /// Send password reset link
    pub async fn send_password_reset_email(
        &self,
        to_email: &str,
        username: &str,
        token: &str,
    ) -> Result<(), String> {
        let reset_url = format!("{}/reset-password?token={}", self.config.app_url, token);

        let html_body = format!(
            r#"
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body {{ font-family: 'Segoe UI', Arial, sans-serif; background: #1e1f22; color: #dbdee1; padding: 20px; }}
                    .container {{ max-width: 600px; margin: 0 auto; background: #2b2d31; border-radius: 8px; padding: 30px; }}
                    h1 {{ color: #f2f3f5; }}
                    .button {{ display: inline-block; background: #5865f2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: 600; }}
                    .footer {{ margin-top: 20px; font-size: 12px; color: #949ba4; }}
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Reset Your Password</h1>
                    <p>Hi {username},</p>
                    <p>We received a request to reset your password. Click the button below to set a new password:</p>
                    <p><a href="{reset_url}" class="button">Reset Password</a></p>
                    <p>Or copy this link: {reset_url}</p>
                    <p class="footer">This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
                </div>
            </body>
            </html>
            "#,
            username = username,
            reset_url = reset_url
        );

        let email = Message::builder()
            .from(
                self.config
                    .from_email
                    .parse()
                    .map_err(|e| format!("Invalid from email: {}", e))?,
            )
            .to(to_email
                .parse()
                .map_err(|e| format!("Invalid to email: {}", e))?)
            .subject("Reset your Puca password")
            .header(ContentType::TEXT_HTML)
            .body(html_body)
            .map_err(|e| format!("Failed to build email: {}", e))?;

        let transport = self.create_transport()?;
        transport
            .send(email)
            .await
            .map_err(|e| format!("Failed to send email: {}", e))?;

        tracing::info!("Password reset email sent (domain {})", crate::logtag::mail_domain(&to_email));
        Ok(())
    }
}

/// Generate a secure random token
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
