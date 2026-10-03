import { useSyncExternalStore } from 'react';
import { getGamesState, subscribeGames, type GamesState } from './gamesStore';

/** The games store, re-rendering on every change (see gamesStore.ts). */
export function useGames(): GamesState {
    return useSyncExternalStore(subscribeGames, getGamesState, getGamesState);
}
