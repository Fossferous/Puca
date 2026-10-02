//! Which tables are open, and where. **One table per call.**
//!
//! Owner rule (2026-10-02): a voice room holds at most ONE game table at a
//! time, whatever the game. Opening a second one — Poker beside Poker, or
//! Blackjack beside Poker — is refused with [`OpenError::RoomHasTable`] until
//! the first is closed. The rule lives in this type rather than in a check the
//! server remembers to make: the map is keyed by room, so a second table for a
//! room has nowhere to go.
//!
//! The registry is generic over the room key `K` (the server's `RoomId`) and
//! the table handle `T` (the server keeps whatever it locks, e.g. an
//! `Arc<Mutex<HoldemTable>>`); it never looks inside `T`. Like the rest of the
//! crate it is synchronous and does no I/O. Every table gets a [`TableId`]
//! that is never reused while the registry lives, so a frame or a moderator's
//! "close" aimed at a table that has since closed cannot land on the table
//! that replaced it in the same room.

use std::collections::HashMap;
use std::fmt;
use std::hash::Hash;

/// The server-wide cap the design suggests (docs/GAMES.md).
pub const DEFAULT_MAX_OPEN_TABLES: usize = 500;

/// Table ids stay below 2^53 so a JavaScript client holds them exactly.
pub const MAX_TABLE_ID: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GameKind {
    Holdem,
    Blackjack,
}

impl GameKind {
    /// The name people see.
    pub const fn label(self) -> &'static str {
        match self {
            GameKind::Holdem => "Poker",
            GameKind::Blackjack => "Blackjack",
        }
    }
}

/// Names one table for as long as the registry lives.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TableId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// The call already has a table (`open` names it); it must close first.
    RoomHasTable { open: TableId, kind: GameKind },
    /// The server-wide cap on open tables.
    TooManyTables { cap: usize },
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::RoomHasTable { kind, .. } => write!(
                f,
                "a {} table is already open in this call; it has to close before another game can start",
                kind.label()
            ),
            OpenError::TooManyTables { .. } => {
                write!(f, "too many game tables are open on this server right now; try again later")
            }
        }
    }
}

impl std::error::Error for OpenError {}

/// One open table.
#[derive(Debug)]
pub struct OpenTable<T> {
    pub id: TableId,
    pub kind: GameKind,
    pub table: T,
}

/// The open tables, at most one per room.
#[derive(Debug)]
pub struct RoomTables<K, T> {
    by_room: HashMap<K, OpenTable<T>>,
    max_open: usize,
    next_id: u64,
}

impl<K: Eq + Hash + Clone, T> RoomTables<K, T> {
    /// `max_open` is the server-wide cap. Ids count up from `first_id`
    /// (clamped into `1..=MAX_TABLE_ID`): the server seeds it at random so a
    /// client still holding an id from before a restart does not name a new
    /// table by accident.
    pub fn new(max_open: usize, first_id: u64) -> Self {
        RoomTables { by_room: HashMap::new(), max_open, next_id: first_id.clamp(1, MAX_TABLE_ID) }
    }

    /// Opens `table` in `room`. Refused, changing nothing, if the room already
    /// has a table (of either game) or the server is at its cap.
    pub fn open(&mut self, room: K, kind: GameKind, table: T) -> Result<&mut OpenTable<T>, OpenError> {
        if let Some(open) = self.by_room.get(&room) {
            return Err(OpenError::RoomHasTable { open: open.id, kind: open.kind });
        }
        if self.by_room.len() >= self.max_open {
            return Err(OpenError::TooManyTables { cap: self.max_open });
        }
        let id = TableId(self.next_id);
        self.next_id = if self.next_id >= MAX_TABLE_ID { 1 } else { self.next_id + 1 };
        Ok(self.by_room.entry(room).or_insert(OpenTable { id, kind, table }))
    }

    /// The room's table, if one is open.
    pub fn get(&self, room: &K) -> Option<&OpenTable<T>> {
        self.by_room.get(room)
    }

    /// The room's table only if it is still table `id` — what a frame naming
    /// a table must resolve through.
    pub fn get_mut(&mut self, room: &K, id: TableId) -> Option<&mut OpenTable<T>> {
        self.by_room.get_mut(room).filter(|t| t.id == id)
    }

    /// Closes table `id` in `room`. A close for a table that is no longer the
    /// room's (it closed, and maybe another opened) is `None` and changes
    /// nothing.
    pub fn close(&mut self, room: &K, id: TableId) -> Option<OpenTable<T>> {
        if self.by_room.get(room)?.id != id {
            return None;
        }
        self.by_room.remove(room)
    }

    /// Closes whatever is open in `room` (the room emptied, the channel was
    /// deleted).
    pub fn close_room(&mut self, room: &K) -> Option<OpenTable<T>> {
        self.by_room.remove(room)
    }

    /// Closes every table whose room matches (games switched off on a
    /// server), returning them so the caller can tell their players.
    pub fn close_where(&mut self, mut pred: impl FnMut(&K) -> bool) -> Vec<(K, OpenTable<T>)> {
        let rooms: Vec<K> = self.by_room.keys().filter(|k| pred(k)).cloned().collect();
        rooms.into_iter().filter_map(|k| self.by_room.remove(&k).map(|t| (k, t))).collect()
    }

    pub fn len(&self) -> usize {
        self.by_room.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> RoomTables<&'static str, &'static str> {
        RoomTables::new(DEFAULT_MAX_OPEN_TABLES, 1)
    }

    #[test]
    fn a_call_holds_one_table_and_a_second_of_either_game_is_refused() {
        for (first, second) in [
            (GameKind::Holdem, GameKind::Holdem),
            (GameKind::Holdem, GameKind::Blackjack),
            (GameKind::Blackjack, GameKind::Holdem),
            (GameKind::Blackjack, GameKind::Blackjack),
        ] {
            let mut r = reg();
            let id = r.open("voice_1", first, "first").unwrap().id;
            let err = r.open("voice_1", second, "second").unwrap_err();
            assert_eq!(err, OpenError::RoomHasTable { open: id, kind: first });
            // The refusal changed nothing: the first table is still THE table.
            assert_eq!(r.len(), 1);
            let open = r.get(&"voice_1").unwrap();
            assert_eq!((open.id, open.kind, open.table), (id, first, "first"));
        }
    }

    #[test]
    fn the_refusal_says_which_game_is_open_and_that_it_must_close_first() {
        let mut r = reg();
        r.open("voice_1", GameKind::Blackjack, "bj").unwrap();
        let msg = r.open("voice_1", GameKind::Holdem, "poker").unwrap_err().to_string();
        assert!(msg.contains("Blackjack") && msg.contains("close"), "{msg}");
    }

    #[test]
    fn other_calls_are_independent() {
        let mut r = reg();
        let a = r.open("voice_1", GameKind::Holdem, "a").unwrap().id;
        let b = r.open("voice_2", GameKind::Holdem, "b").unwrap().id;
        assert_ne!(a, b);
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn after_the_table_closes_a_new_one_opens_with_a_new_id() {
        let mut r = reg();
        let old = r.open("voice_1", GameKind::Holdem, "old").unwrap().id;
        assert_eq!(r.close(&"voice_1", old).map(|t| t.table), Some("old"));
        assert!(r.get(&"voice_1").is_none());
        let new = r.open("voice_1", GameKind::Blackjack, "new").unwrap().id;
        assert_ne!(old, new, "ids are never reused");
        // A frame or a moderator's close aimed at the OLD table cannot reach
        // the new one.
        assert!(r.get_mut(&"voice_1", old).is_none());
        assert!(r.close(&"voice_1", old).is_none());
        assert_eq!(r.get_mut(&"voice_1", new).map(|t| t.table), Some("new"));
        assert_eq!(r.len(), 1);
    }

    #[test]
    fn the_server_wide_cap_refuses_without_changing_anything() {
        let mut r: RoomTables<u32, ()> = RoomTables::new(2, 1);
        r.open(1, GameKind::Holdem, ()).unwrap();
        r.open(2, GameKind::Blackjack, ()).unwrap();
        assert_eq!(r.open(3, GameKind::Holdem, ()).unwrap_err(), OpenError::TooManyTables { cap: 2 });
        assert_eq!(r.len(), 2);
        assert!(r.get(&3).is_none());
        // A room that already has a table hears THAT, not the cap.
        assert!(matches!(r.open(1, GameKind::Holdem, ()), Err(OpenError::RoomHasTable { .. })));
        r.close_room(&1).unwrap();
        r.open(3, GameKind::Holdem, ()).unwrap();
    }

    #[test]
    fn close_where_ends_every_matching_table_and_only_those() {
        let mut r: RoomTables<(u32, u32), u32> = RoomTables::new(10, 1);
        // (server, channel)
        r.open((1, 10), GameKind::Holdem, 0).unwrap();
        r.open((1, 11), GameKind::Blackjack, 1).unwrap();
        r.open((2, 20), GameKind::Holdem, 2).unwrap();
        let mut closed: Vec<u32> = r.close_where(|&(server, _)| server == 1).into_iter().map(|(_, t)| t.table).collect();
        closed.sort_unstable();
        assert_eq!(closed, [0, 1]);
        assert_eq!(r.len(), 1);
        assert!(r.get(&(2, 20)).is_some());
    }

    #[test]
    fn ids_start_where_the_server_seeds_them_and_stay_javascript_safe() {
        let mut r: RoomTables<u32, ()> = RoomTables::new(10, 1_000);
        assert_eq!(r.open(1, GameKind::Holdem, ()).unwrap().id, TableId(1_000));
        assert_eq!(r.open(2, GameKind::Holdem, ()).unwrap().id, TableId(1_001));
        // Out-of-range seeds are clamped, and the counter wraps inside the
        // safe range instead of leaving it.
        let mut r: RoomTables<u32, ()> = RoomTables::new(10, 0);
        assert_eq!(r.open(1, GameKind::Holdem, ()).unwrap().id, TableId(1));
        let mut r: RoomTables<u32, ()> = RoomTables::new(10, u64::MAX);
        assert_eq!(r.open(1, GameKind::Holdem, ()).unwrap().id, TableId(MAX_TABLE_ID));
        assert_eq!(r.open(2, GameKind::Holdem, ()).unwrap().id, TableId(1));
    }
}
