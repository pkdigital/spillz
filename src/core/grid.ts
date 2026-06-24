import { PIECE_OPENINGS } from "./pieces";
import type { Cell, Coord, JunkType, PieceType, PowerType } from "./types";

/** Optional flavour applied when placing a cell. */
export interface CellExtras {
  power?: PowerType;
  junk?: JunkType;
}

/**
 * Sparse grid: fixed `cols` wide, bounded at the top (row 0) and sides, but
 * UNBOUNDED downward — the world is an infinite vertical strip the camera scrolls
 * through. Cells are stored by world coord, so running off the bottom simply
 * means "the next cell is empty" (which already spills) rather than a hard edge.
 */
export class Grid {
  readonly cols: number;
  private cells = new Map<string, Cell>();

  constructor(cols: number) {
    this.cols = cols;
  }

  private key(c: Coord): string {
    return `${c.row},${c.col}`;
  }

  /** In bounds = within the side walls and at/below the top row. No bottom. */
  inBounds(c: Coord): boolean {
    return c.col >= 0 && c.col < this.cols && c.row >= 0;
  }

  get(c: Coord): Cell | null {
    if (!this.inBounds(c)) return null;
    return this.cells.get(this.key(c)) ?? null;
  }

  isEmpty(c: Coord): boolean {
    return this.inBounds(c) && !this.cells.has(this.key(c));
  }

  /** Place a piece, deriving its openings from the type. Returns false if blocked. */
  place(c: Coord, type: PieceType, extras: CellExtras = {}): boolean {
    if (!this.isEmpty(c)) return false;
    this.cells.set(this.key(c), this.makeCell(type, extras));
    return true;
  }

  /** Force-set a cell (used to seed the source, or to overwrite). */
  set(c: Coord, type: PieceType, extras: CellExtras = {}): void {
    if (!this.inBounds(c)) return;
    this.cells.set(this.key(c), this.makeCell(type, extras));
  }

  /** Remove a cell, leaving it empty/buildable (e.g. a fatberg cleared by dynamite). */
  clear(c: Coord): void {
    this.cells.delete(this.key(c));
  }

  private makeCell(type: PieceType, extras: CellExtras): Cell {
    const cell: Cell = { type, openings: PIECE_OPENINGS[type] };
    if (extras.power) cell.power = extras.power;
    if (extras.junk) cell.junk = extras.junk;
    return cell;
  }
}
