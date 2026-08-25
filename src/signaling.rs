#![allow(dead_code)]

//! WebRTC Signaling for Game Streaming
//!
//! This module handles the signaling layer for WebRTC connections,
//! allowing peers to exchange SDP offers/answers and ICE candidates.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

/// Signaling message types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum SignalMessage {
    /// Join a streaming room
    Join { room_id: String, user_id: String },
    /// Leave a room
    Leave { room_id: String, user_id: String },
    /// SDP Offer from streamer
    Offer { target_user: String, sdp: String },
    /// SDP Answer from viewer
    Answer { target_user: String, sdp: String },
    /// ICE Candidate exchange
    IceCandidate {
        target_user: String,
        candidate: String,
    },
    /// Room state update
    RoomState {
        users: Vec<String>,
        streamer: Option<String>,
    },
    /// Error message
    Error { message: String },
}

/// A streaming room
#[derive(Debug, Clone)]
pub struct StreamRoom {
    pub id: String,
    pub streamer_id: Option<String>,
    pub viewers: Vec<String>,
}

impl StreamRoom {
    pub fn new(id: String) -> Self {
        Self {
            id,
            streamer_id: None,
            viewers: Vec::new(),
        }
    }

    pub fn add_viewer(&mut self, user_id: String) {
        if !self.viewers.contains(&user_id) {
            self.viewers.push(user_id);
        }
    }

    pub fn remove_user(&mut self, user_id: &str) {
        self.viewers.retain(|u| u != user_id);
        if self.streamer_id.as_deref() == Some(user_id) {
            self.streamer_id = None;
        }
    }

    pub fn set_streamer(&mut self, user_id: String) {
        self.streamer_id = Some(user_id);
    }

    pub fn all_users(&self) -> Vec<String> {
        let mut users = self.viewers.clone();
        if let Some(ref streamer) = self.streamer_id {
            if !users.contains(streamer) {
                users.push(streamer.clone());
            }
        }
        users
    }
}

/// Signaling state manager
pub struct SignalingState {
    rooms: RwLock<HashMap<String, StreamRoom>>,
    /// Broadcast channel for each room
    room_channels: RwLock<HashMap<String, broadcast::Sender<SignalMessage>>>,
}

impl SignalingState {
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
            room_channels: RwLock::new(HashMap::new()),
        }
    }

    /// Get or create a room
    pub async fn get_or_create_room(&self, room_id: &str) -> StreamRoom {
        let mut rooms = self.rooms.write().await;
        rooms
            .entry(room_id.to_string())
            .or_insert_with(|| StreamRoom::new(room_id.to_string()))
            .clone()
    }

    /// Join a room
    pub async fn join_room(
        &self,
        room_id: &str,
        user_id: &str,
    ) -> broadcast::Receiver<SignalMessage> {
        // Update room
        {
            let mut rooms = self.rooms.write().await;
            let room = rooms
                .entry(room_id.to_string())
                .or_insert_with(|| StreamRoom::new(room_id.to_string()));
            room.add_viewer(user_id.to_string());
        }

        // Get or create broadcast channel
        let mut channels = self.room_channels.write().await;
        let tx = channels
            .entry(room_id.to_string())
            .or_insert_with(|| broadcast::channel(100).0);

        tx.subscribe()
    }

    /// Leave a room
    pub async fn leave_room(&self, room_id: &str, user_id: &str) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.remove_user(user_id);

            // Clean up empty rooms
            if room.all_users().is_empty() {
                rooms.remove(room_id);
                let mut channels = self.room_channels.write().await;
                channels.remove(room_id);
            }
        }
    }

    /// Broadcast a message to a room
    pub async fn broadcast(&self, room_id: &str, message: SignalMessage) {
        let channels = self.room_channels.read().await;
        if let Some(tx) = channels.get(room_id) {
            let _ = tx.send(message);
        }
    }

    /// Start streaming in a room
    pub async fn start_streaming(&self, room_id: &str, user_id: &str) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            room.set_streamer(user_id.to_string());
        }
    }

    /// Get room state
    pub async fn get_room_state(&self, room_id: &str) -> Option<StreamRoom> {
        let rooms = self.rooms.read().await;
        rooms.get(room_id).cloned()
    }
}

impl Default for SignalingState {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a shared signaling state
pub fn create_signaling_state() -> Arc<SignalingState> {
    Arc::new(SignalingState::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_room_lifecycle() {
        let state = SignalingState::new();

        // Join room
        let _rx = state.join_room("room1", "user1").await;
        let room = state.get_room_state("room1").await.unwrap();
        assert!(room.viewers.contains(&"user1".to_string()));

        // Start streaming
        state.start_streaming("room1", "user1").await;
        let room = state.get_room_state("room1").await.unwrap();
        assert_eq!(room.streamer_id, Some("user1".to_string()));

        // Leave room
        state.leave_room("room1", "user1").await;
        let room = state.get_room_state("room1").await;
        assert!(room.is_none()); // Room cleaned up
    }
}
