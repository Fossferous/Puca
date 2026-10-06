/**
 * Where each seat sits around the card table's oval (docs/GAMES.md, *The
 * table on screen*).
 *
 * The viewer's own seat is at the bottom (a spectator's anchor is seat 1, the
 * first seat); the others follow CLOCKWISE in seat order, the way the engine
 * moves the button and the turn - so the player who acts after you sits on
 * your left, as at a real table. Positions are percentages of the table's
 * box: the component clamps them so a seat tile never leaves the box.
 */

export type SeatSide = 'top' | 'bottom' | 'left' | 'right';

export interface SeatSpot {
    seat: number;
    /** Centre of the seat, 0..100 across the table box. */
    x: number;
    /** Centre of the seat, 0..100 down the table box. */
    y: number;
    /** Which edge of the table the seat is on: its bet sits on the felt side. */
    side: SeatSide;
}

/** Radii of the ring the seats sit on, in percent of the box. */
const RX = 44;
const RY = 42;

export function seatSpots(maxSeats: number, anchor: number | null): SeatSpot[] {
    const n = Math.max(1, maxSeats);
    const a = anchor !== null && anchor >= 0 && anchor < n ? anchor : 0;
    return [...Array(n).keys()].map(seat => {
        // 90deg is straight down on screen (y grows downward); adding angle
        // goes bottom -> left -> top -> right: clockwise on screen.
        const k = (seat - a + n) % n;
        const theta = Math.PI / 2 + (k * 2 * Math.PI) / n;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const side: SeatSide = sin > 0.6 ? 'bottom' : sin < -0.6 ? 'top' : cos < 0 ? 'left' : 'right';
        return { seat, x: 50 + RX * cos, y: 50 + RY * sin, side };
    });
}
