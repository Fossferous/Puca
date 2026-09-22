/**
 * MOVED to components/notes/Popover.tsx — this colour/label chrome is shared
 * with Púca's Tasks view now, so it no longer belongs under notes/.
 *
 * This re-export is here for the branches that were cut before the move and
 * still import './Popover' from inside notes/components/ (a rename on one
 * side and a new importer on the other merge CLEANLY and then fail to
 * build). Delete it, and fix the importers, once they are all in.
 */
export { Popover } from '../../components/notes/Popover';
