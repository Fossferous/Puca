use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth::Claims;
use crate::permissions::{user_has_permission, Permissions};
use crate::state::AppState;

// --- DTOs ---

#[derive(Deserialize)]
pub struct CreateCategoryRequest {
    pub name: String,
    pub position: Option<i32>,
}

#[derive(Serialize)]
pub struct CategoryResponse {
    pub id: i64,
    pub server_id: String,
    pub name: String,
    pub position: i32,
}

// --- Handlers ---

/// Create a channel category
pub async fn create_category(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateCategoryRequest>,
) -> impl IntoResponse {
    // Check permission
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission").into_response();
    }

    let position = payload.position.unwrap_or(0);
    // channel_categories.id is INT4 — RETURNING it as i64 fails to decode
    // (ColumnDecode), which surfaced as a 500 on every category create.
    let result: Result<(i32,), _> = sqlx::query_as(
        "INSERT INTO channel_categories (server_id, name, position) VALUES ($1, $2, $3) RETURNING id"
    )
    .bind(&server_id)
    .bind(&payload.name)
    .bind(position)
    .fetch_one(&state.pool)
    .await;

    match result {
        Ok((id,)) => Json(CategoryResponse {
            id: id as i64,
            server_id,
            name: payload.name,
            position,
        })
        .into_response(),
        Err(e) => {
            tracing::error!("Failed to create category: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to create category",
            )
                .into_response()
        }
    }
}

/// List categories for a server
pub async fn list_categories(
    State(state): State<Arc<AppState>>,
    Path(server_id): Path<String>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    // Verify user is a member of the server (i32: server_members.user_id is INT4) —
    // otherwise any authenticated user could enumerate a private server's layout.
    let is_member = sqlx::query_as::<_, (i32,)>(
        "SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(claims.sub as i32)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    if is_member.is_none() {
        return (StatusCode::FORBIDDEN, "Not a member of this server").into_response();
    }

    // channel_categories.id is INT4 — decode as i32 (i64 would make query_as error,
    // which .unwrap_or_default() silently turns into an empty category list).
    let categories: Vec<(i32, String, String, i32)> = sqlx::query_as(
        "SELECT id, server_id, name, position FROM channel_categories WHERE server_id = $1 ORDER BY position"
    )
    .bind(&server_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let response: Vec<CategoryResponse> = categories
        .into_iter()
        .map(|(id, server_id, name, position)| CategoryResponse {
            id: id as i64,
            server_id,
            name,
            position,
        })
        .collect();

    Json(response).into_response()
}

/// Delete a category
pub async fn delete_category(
    State(state): State<Arc<AppState>>,
    Path((server_id, category_id)): Path<(String, i64)>,
    Extension(claims): Extension<Claims>,
) -> impl IntoResponse {
    if !user_has_permission(
        &state.pool,
        &server_id,
        claims.sub,
        Permissions::MANAGE_CHANNELS,
    )
    .await
    {
        return (StatusCode::FORBIDDEN, "Missing MANAGE_CHANNELS permission").into_response();
    }

    // Detach channels in this category. category_id is a global SERIAL, so this
    // MUST be scoped to server_id — otherwise a caller authorized on server A
    // could pass a category id belonging to server B and null out B's channels.
    let _ = sqlx::query(
        "UPDATE channels SET category_id = NULL WHERE category_id = $1 AND server_id = $2",
    )
    .bind(category_id)
    .bind(&server_id)
    .execute(&state.pool)
    .await;

    let result = sqlx::query("DELETE FROM channel_categories WHERE id = $1 AND server_id = $2")
        .bind(category_id)
        .bind(&server_id)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::error!("Failed to delete category: {:?}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to delete category",
            )
                .into_response()
        }
    }
}
