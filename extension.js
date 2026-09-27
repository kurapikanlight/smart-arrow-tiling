import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const VERSION = '11.0-clean-core';

const SEQUENCE_DELAY_MS = 320;
const LIVE_RESIZE_INTERVAL_MS = 30;
const GEOMETRY_RETRY_MS = 25;
const GEOMETRY_RETRY_MAX = 20;

const OUTER_GAP = 1;
const INNER_GAP = 1;
const EDGE_TOLERANCE = 36;
const GEOMETRY_TOLERANCE = 5;
const RESIZE_TOLERANCE = 2;
const MIN_REGION_SIZE = 90;

const KEYBINDINGS = [
    'tile-left',
    'tile-right',
    'tile-up',
    'tile-down',
];

export default class SmartArrowTilingExtension extends Extension {
    enable() {
        console.log(`[Smart Arrow Tiling] ENABLE ${VERSION}`);

        this._settings = this.getSettings();
        this._pendingHorizontal = null;
        this._pendingHorizontalTimer = 0;
        this._pendingRects = new Map();
        this._geometryTimers = new Map();
        this._grab = null;
        this._liveResizeTimer = 0;

        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const mode = Shell.ActionMode.NORMAL;

        Main.wm.addKeybinding(
            'tile-left',
            this._settings,
            flags,
            mode,
            () => this._onHorizontal('left')
        );

        Main.wm.addKeybinding(
            'tile-right',
            this._settings,
            flags,
            mode,
            () => this._onHorizontal('right')
        );

        // Super+Up / Super+Down are sequence keys only.
        // Standalone maximize/minimize is intentionally left to GNOME,
        // which install.sh configures as Alt+Up / Alt+Down.
        Main.wm.addKeybinding(
            'tile-up',
            this._settings,
            flags,
            mode,
            () => this._onVertical('top')
        );

        Main.wm.addKeybinding(
            'tile-down',
            this._settings,
            flags,
            mode,
            () => this._onVertical('bottom')
        );

        this._grabBeginId = global.display.connect(
            'grab-op-begin',
            (_display, win) => this._onGrabBegin(win)
        );

        this._grabEndId = global.display.connect(
            'grab-op-end',
            (_display, win) => this._onGrabEnd(win)
        );

        console.log(`[Smart Arrow Tiling] READY ${VERSION}`);
    }

    disable() {
        this._cancelPendingHorizontal(false);
        this._stopLiveResize();

        for (const name of KEYBINDINGS) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (_) {
            }
        }

        if (this._grabBeginId) {
            try {
                global.display.disconnect(this._grabBeginId);
            } catch (_) {
            }
            this._grabBeginId = 0;
        }

        if (this._grabEndId) {
            try {
                global.display.disconnect(this._grabEndId);
            } catch (_) {
            }
            this._grabEndId = 0;
        }

        for (const sourceId of this._geometryTimers?.values() ?? []) {
            try {
                GLib.Source.remove(sourceId);
            } catch (_) {
            }
        }

        this._geometryTimers?.clear();
        this._pendingRects?.clear();

        this._settings = null;
        this._pendingHorizontal = null;
        this._pendingRects = null;
        this._geometryTimers = null;
        this._grab = null;

        console.log(`[Smart Arrow Tiling] DISABLE ${VERSION}`);
    }

    // ---------------------------------------------------------
    // Key handling
    // ---------------------------------------------------------

    _onHorizontal(side) {
        const win = this._focusedWindow();
        if (!win)
            return;

        const pending = this._pendingHorizontal;

        // Same key twice => 1/3 + 2/3 layout.
        if (pending?.win === win && pending.side === side) {
            this._cancelPendingHorizontal(false);
            this._tileThird(win, side);
            return;
        }

        // Finish an unrelated pending horizontal action first.
        if (pending) {
            this._cancelPendingHorizontal(false);
            this._executeHorizontal(pending);
        }

        const sourceRect = this._rect(win);
        if (!sourceRect)
            return;

        this._pendingHorizontal = {
            win,
            side,
            sourceRect: {...sourceRect},
        };

        this._pendingHorizontalTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SEQUENCE_DELAY_MS,
            () => {
                const action = this._pendingHorizontal;
                this._pendingHorizontal = null;
                this._pendingHorizontalTimer = 0;

                if (action?.win)
                    this._executeHorizontal(action);

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _onVertical(vertical) {
        const win = this._focusedWindow();
        if (!win)
            return;

        const pending = this._pendingHorizontal;

        // Vertical keys only complete a horizontal sequence.
        // Standalone Super+Up / Super+Down intentionally do nothing.
        if (pending?.win !== win) {
            this._cancelPendingHorizontal(false);
            return;
        }

        this._cancelPendingHorizontal(false);
        this._moveQuarterAtomic(
            win,
            pending.side,
            vertical,
            pending.sourceRect
        );
    }

    _cancelPendingHorizontal(execute = false) {
        const pending = this._pendingHorizontal;

        if (this._pendingHorizontalTimer) {
            try {
                GLib.Source.remove(this._pendingHorizontalTimer);
            } catch (_) {
            }
            this._pendingHorizontalTimer = 0;
        }

        this._pendingHorizontal = null;

        if (execute && pending?.win)
            this._executeHorizontal(pending);
    }

    _executeHorizontal(action) {
        const {win, side, sourceRect} = action;
        if (!this._isSupportedWindow(win))
            return;

        const area = this._screenArea(win);
        const current = this._effectiveRect(win);

        if (!this._isLikelyTiled(current, area)) {
            this._snapFloatingHalf(win, side, sourceRect);
            return;
        }

        const sourceSide = this._side(current, area);

        // Already in this column. Leave the current layout alone.
        // A second same-side key is handled by _tileThird().
        if (sourceSide === side)
            return;

        if (this._isFullHeight(current, area)) {
            this._moveFullColumn(win, side, current);
            return;
        }

        this._moveQuarterAtomic(
            win,
            side,
            this._verticalSlot(current, area),
            current
        );
    }

    // ---------------------------------------------------------
    // Window / workspace helpers
    // ---------------------------------------------------------

    _isSupportedWindow(win) {
        if (!win || win.is_fullscreen())
            return false;

        const type = win.get_window_type();
        return [
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ].includes(type);
    }

    _focusedWindow() {
        const win = global.display.get_focus_window();
        return this._isSupportedWindow(win) ? win : null;
    }

    _screenArea(win) {
        return global.display.get_monitor_geometry(win.get_monitor());
    }

    _bounds(area) {
        return {
            left: area.x + OUTER_GAP,
            top: area.y + OUTER_GAP,
            right: area.x + area.width - OUTER_GAP,
            bottom: area.y + area.height - OUTER_GAP,
        };
    }

    _rect(win) {
        try {
            return {...win.get_frame_rect()};
        } catch (_) {
            return null;
        }
    }

    _effectiveRect(win) {
        return this._pendingRects?.get(win.get_id()) ?? this._rect(win);
    }

    _entries(win, area) {
        const workspace = win.get_workspace();
        const monitor = win.get_monitor();
        const result = [];

        for (const peer of workspace.list_windows()) {
            if (
                peer === win ||
                peer.get_monitor() !== monitor ||
                peer.is_hidden() ||
                !this._isSupportedWindow(peer)
            ) {
                continue;
            }

            const rect = this._effectiveRect(peer);
            if (!rect || !this._isLikelyTiled(rect, area))
                continue;

            result.push(this._entry(peer, rect, area));
        }

        return result;
    }

    _entry(win, rect, area) {
        return {
            win,
            rect: {...rect},
            side: this._side(rect, area),
            vertical: this._verticalSlot(rect, area),
            fullHeight: this._isFullHeight(rect, area),
        };
    }

    _entriesOnSide(entries, side) {
        return entries
            .filter(entry => entry.side === side)
            .sort((a, b) => a.rect.y - b.rect.y);
    }

    _oppositeSide(side) {
        return side === 'left' ? 'right' : 'left';
    }

    _oppositeVertical(vertical) {
        return vertical === 'top' ? 'bottom' : 'top';
    }

    // ---------------------------------------------------------
    // Geometry classification
    // ---------------------------------------------------------

    _side(rect, area) {
        const center = rect.x + rect.width / 2;
        return center < area.x + area.width / 2 ? 'left' : 'right';
    }

    _verticalSlot(rect, area) {
        const center = rect.y + rect.height / 2;
        return center < area.y + area.height / 2 ? 'top' : 'bottom';
    }

    _isFullHeight(rect, area) {
        const b = this._bounds(area);
        return (
            Math.abs(rect.y - b.top) <= EDGE_TOLERANCE &&
            Math.abs(rect.y + rect.height - b.bottom) <= EDGE_TOLERANCE
        );
    }

    _isLikelyTiled(rect, area) {
        if (!rect)
            return false;

        const b = this._bounds(area);
        const touchesSide =
            Math.abs(rect.x - b.left) <= EDGE_TOLERANCE ||
            Math.abs(rect.x + rect.width - b.right) <= EDGE_TOLERANCE;

        const touchesVerticalEdge =
            Math.abs(rect.y - b.top) <= EDGE_TOLERANCE ||
            Math.abs(rect.y + rect.height - b.bottom) <= EDGE_TOLERANCE;

        return (
            touchesSide &&
            touchesVerticalEdge &&
            rect.width >= MIN_REGION_SIZE &&
            rect.height >= MIN_REGION_SIZE
        );
    }

    // ---------------------------------------------------------
    // Canonical regions
    // ---------------------------------------------------------

    _halves(area) {
        const b = this._bounds(area);
        const usable = Math.max(2, b.right - b.left - INNER_GAP);
        const leftWidth = Math.floor(usable / 2);
        const rightWidth = usable - leftWidth;
        const height = Math.max(1, b.bottom - b.top);

        return {
            left: {
                x: b.left,
                y: b.top,
                width: leftWidth,
                height,
            },
            right: {
                x: b.left + leftWidth + INNER_GAP,
                y: b.top,
                width: rightWidth,
                height,
            },
        };
    }

    _quarter(area, side, vertical) {
        const half = this._halves(area)[side];
        const split = this._splitVerticalRegion(half, 0.5);
        return split[vertical];
    }

    _thirdPair(area, side) {
        const b = this._bounds(area);
        const width = Math.max(3, b.right - b.left - INNER_GAP);
        const oneThird = Math.round(width / 3);
        const twoThird = width - oneThird;
        const height = Math.max(1, b.bottom - b.top);

        if (side === 'left') {
            return {
                current: {
                    x: b.left,
                    y: b.top,
                    width: oneThird,
                    height,
                },
                complement: {
                    x: b.left + oneThird + INNER_GAP,
                    y: b.top,
                    width: twoThird,
                    height,
                },
            };
        }

        return {
            complement: {
                x: b.left,
                y: b.top,
                width: twoThird,
                height,
            },
            current: {
                x: b.left + twoThird + INNER_GAP,
                y: b.top,
                width: oneThird,
                height,
            },
        };
    }

    _columnRegionFromRect(rect, area) {
        const b = this._bounds(area);
        const x = Math.max(b.left, Math.round(rect.x));
        const right = Math.min(b.right, Math.round(rect.x + rect.width));

        return {
            x,
            y: b.top,
            width: Math.max(MIN_REGION_SIZE, right - x),
            height: Math.max(MIN_REGION_SIZE, b.bottom - b.top),
        };
    }

    _columnRegionFromEntries(entries, side, area) {
        if (!entries.length)
            return this._halves(area)[side];

        let left = Infinity;
        let right = -Infinity;

        for (const entry of entries) {
            left = Math.min(left, entry.rect.x);
            right = Math.max(right, entry.rect.x + entry.rect.width);
        }

        const b = this._bounds(area);
        left = Math.max(b.left, Math.round(left));
        right = Math.min(b.right, Math.round(right));

        if (right - left < MIN_REGION_SIZE)
            return this._halves(area)[side];

        return {
            x: left,
            y: b.top,
            width: right - left,
            height: b.bottom - b.top,
        };
    }

    _splitVerticalRegion(region, ratio = 0.5) {
        const usable = Math.max(2, region.height - INNER_GAP);
        const minRatio = MIN_REGION_SIZE / usable;
        const clampedRatio = Math.max(
            minRatio,
            Math.min(1 - minRatio, ratio)
        );

        const topHeight = Math.max(
            MIN_REGION_SIZE,
            Math.min(
                usable - MIN_REGION_SIZE,
                Math.round(usable * clampedRatio)
            )
        );

        const bottomHeight = usable - topHeight;

        return {
            top: {
                x: region.x,
                y: region.y,
                width: region.width,
                height: topHeight,
            },
            bottom: {
                x: region.x,
                y: region.y + topHeight + INNER_GAP,
                width: region.width,
                height: bottomHeight,
            },
        };
    }

    _missingVerticalRegion(existing, wanted, columnRegion) {
        if (existing.vertical === wanted)
            return {...existing.rect};

        const btm = columnRegion.y + columnRegion.height;

        if (wanted === 'top') {
            const height = existing.rect.y - INNER_GAP - columnRegion.y;
            if (height >= MIN_REGION_SIZE) {
                return {
                    x: columnRegion.x,
                    y: columnRegion.y,
                    width: columnRegion.width,
                    height,
                };
            }
        } else {
            const y = existing.rect.y + existing.rect.height + INNER_GAP;
            const height = btm - y;
            if (height >= MIN_REGION_SIZE) {
                return {
                    x: columnRegion.x,
                    y,
                    width: columnRegion.width,
                    height,
                };
            }
        }

        return this._splitVerticalRegion(columnRegion, 0.5)[wanted];
    }

    _verticalRatio(rect, columnRegion, vertical) {
        if (!rect || !columnRegion)
            return 0.5;

        const usable = Math.max(1, columnRegion.height - INNER_GAP);

        if (vertical === 'top')
            return Math.max(0.2, Math.min(0.8, rect.height / usable));

        return Math.max(
            0.2,
            Math.min(0.8, 1 - rect.height / usable)
        );
    }

    // ---------------------------------------------------------
    // Plan helpers
    // ---------------------------------------------------------

    _pushMove(plan, win, rect) {
        if (!win || !rect)
            return;

        if (rect.width < 1 || rect.height < 1)
            return;

        plan.set(win.get_id(), {
            win,
            rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            },
        });
    }

    _fitVertical(plan, entries, region) {
        if (!entries.length)
            return;

        if (entries.length === 1) {
            this._pushMove(plan, entries[0].win, region);
            return;
        }

        if (entries.length !== 2)
            return;

        const sorted = [...entries].sort((a, b) => a.rect.y - b.rect.y);
        const total = Math.max(2, sorted[0].rect.height + sorted[1].rect.height);
        const ratio = sorted[0].rect.height / total;
        const split = this._splitVerticalRegion(region, ratio);

        this._pushMove(plan, sorted[0].win, split.top);
        this._pushMove(plan, sorted[1].win, split.bottom);
    }

    _fillVacatedColumn(plan, sourceEntries, sourceRect, area) {
        if (!sourceEntries.length)
            return;

        if (sourceEntries.length > 2)
            return;

        const region = this._columnRegionFromRect(sourceRect, area);
        this._fitVertical(plan, sourceEntries, region);
    }

    _executePlan(plan, label) {
        if (!(plan instanceof Map) || !plan.size)
            return;

        console.log(
            `[Smart Arrow Tiling] ${label}: ${plan.size} window(s)`
        );

        for (const {win, rect} of plan.values())
            this._requestGeometry(win, rect);
    }

    // ---------------------------------------------------------
    // Horizontal actions
    // ---------------------------------------------------------

    _snapFloatingHalf(win, side, sourceRect) {
        const area = this._screenArea(win);
        const peers = this._entries(win, area);
        const target = this._entriesOnSide(peers, side);
        const opposite = this._entriesOnSide(peers, this._oppositeSide(side));
        const plan = new Map();

        if (!target.length) {
            this._pushMove(plan, win, this._halves(area)[side]);
            this._executePlan(plan, `floating-half-${side}`);
            return;
        }

        // If the opposite column is empty, shift the target group there.
        if (!opposite.length && target.length <= 2) {
            this._fitVertical(
                plan,
                target,
                this._halves(area)[this._oppositeSide(side)]
            );
            this._pushMove(plan, win, this._halves(area)[side]);
            this._executePlan(plan, `floating-half-insert-${side}`);
            return;
        }

        // With one target window, use the old floating rect as its destination.
        // This avoids overlap without trying to squeeze five windows into a grid.
        if (target.length === 1) {
            this._pushMove(plan, target[0].win, sourceRect);
            this._pushMove(plan, win, this._columnRegionFromEntries(target, side, area));
            this._executePlan(plan, `floating-half-replace-${side}`);
        }
    }

    _moveFullColumn(win, targetSide, sourceRect) {
        const area = this._screenArea(win);
        const peers = this._entries(win, area);
        const target = this._entriesOnSide(peers, targetSide);
        const plan = new Map();

        if (!target.length) {
            this._pushMove(plan, win, this._halves(area)[targetSide]);
            this._executePlan(plan, `full-column-${targetSide}`);
            return;
        }

        if (target.length > 2)
            return;

        const targetRegion = this._columnRegionFromEntries(target, targetSide, area);
        const sourceRegion = this._columnRegionFromRect(sourceRect, area);

        this._fitVertical(plan, target, sourceRegion);
        this._pushMove(plan, win, targetRegion);
        this._executePlan(plan, `full-column-swap-${targetSide}`);
    }

    _tileThird(win, side) {
        const area = this._screenArea(win);
        const peers = this._entries(win, area);

        // A 4-window grid has three peers. Do not collapse it into an
        // ambiguous 1/3 layout.
        if (peers.length > 2)
            return;

        const pair = this._thirdPair(area, side);
        const plan = new Map();

        this._pushMove(plan, win, pair.current);
        this._fitVertical(plan, peers, pair.complement);
        this._executePlan(plan, `third-${side}`);
    }

    // ---------------------------------------------------------
    // Atomic quarter movement / swapping
    // ---------------------------------------------------------

    _moveQuarterAtomic(win, targetSide, targetVertical, sourceRect) {
        const area = this._screenArea(win);
        const sourceTiled = this._isLikelyTiled(sourceRect, area);
        const sourceSide = sourceTiled ? this._side(sourceRect, area) : null;
        const sourceFull = sourceTiled ? this._isFullHeight(sourceRect, area) : false;
        const sourceVertical = sourceTiled && !sourceFull
            ? this._verticalSlot(sourceRect, area)
            : null;

        const peers = this._entries(win, area);
        const target = this._entriesOnSide(peers, targetSide);
        const sourcePeers = sourceSide
            ? this._entriesOnSide(peers, sourceSide)
            : [];

        const plan = new Map();

        // Do not turn the only full-height window in a column into a lone
        // quarter. That creates the exact black hole this extension avoids.
        if (sourceTiled && sourceSide === targetSide && sourceFull)
            return;

        // Same-column stack movement is a literal top/bottom swap.
        if (sourceTiled && sourceSide === targetSide && !sourceFull) {
            if (sourceVertical === targetVertical)
                return;

            const sibling = target.find(
                entry => !entry.fullHeight && entry.vertical === targetVertical
            );

            if (!sibling)
                return;

            this._pushMove(plan, win, sibling.rect);
            this._pushMove(plan, sibling.win, sourceRect);
            this._executePlan(plan, `same-column-${targetVertical}-swap`);
            return;
        }

        if (target.length > 2)
            return;

        // Exact target slot: literal swap. This is the A <-> D case.
        if (target.length === 2) {
            const victim = target.find(
                entry => !entry.fullHeight && entry.vertical === targetVertical
            );

            if (!victim)
                return;

            this._pushMove(plan, win, victim.rect);

            if (sourceTiled) {
                this._pushMove(plan, victim.win, sourceRect);
            } else {
                this._pushMove(plan, victim.win, sourceRect);
            }

            this._executePlan(plan, `quarter-slot-swap-${targetSide}-${targetVertical}`);
            return;
        }

        if (target.length === 1) {
            const only = target[0];
            const columnRegion = this._columnRegionFromEntries(target, targetSide, area);

            // Full-height destination: split it into two slots. The existing
            // window occupies the opposite slot and the source column heals.
            if (only.fullHeight) {
                const ratio = sourceTiled && !sourceFull
                    ? this._verticalRatio(sourceRect, this._columnRegionFromRect(sourceRect, area), targetVertical)
                    : 0.5;

                const split = this._splitVerticalRegion(columnRegion, ratio);
                this._pushMove(plan, win, split[targetVertical]);
                this._pushMove(plan, only.win, split[this._oppositeVertical(targetVertical)]);

                if (sourceTiled && sourceSide !== targetSide)
                    this._fillVacatedColumn(plan, sourcePeers, sourceRect, area);

                this._executePlan(plan, `quarter-split-full-${targetSide}-${targetVertical}`);
                return;
            }

            // The only window already occupies the requested slot => swap.
            if (only.vertical === targetVertical) {
                this._pushMove(plan, win, only.rect);
                this._pushMove(plan, only.win, sourceRect);
                this._executePlan(plan, `quarter-single-swap-${targetSide}-${targetVertical}`);
                return;
            }

            // The opposite slot exists and the requested slot is empty.
            const desired = this._missingVerticalRegion(
                only,
                targetVertical,
                columnRegion
            );

            this._pushMove(plan, win, desired);

            if (sourceTiled && sourceSide !== targetSide)
                this._fillVacatedColumn(plan, sourcePeers, sourceRect, area);

            this._executePlan(plan, `quarter-fill-empty-${targetSide}-${targetVertical}`);
            return;
        }

        // Empty destination column.
        this._pushMove(plan, win, this._quarter(area, targetSide, targetVertical));

        if (sourceTiled && sourceSide !== targetSide)
            this._fillVacatedColumn(plan, sourcePeers, sourceRect, area);

        this._executePlan(plan, `quarter-empty-${targetSide}-${targetVertical}`);
    }

    // ---------------------------------------------------------
    // Manual resize: linked dividers
    // ---------------------------------------------------------

    _onGrabBegin(win) {
        if (!this._isSupportedWindow(win))
            return;

        const rect = this._rect(win);
        if (!rect)
            return;

        const area = this._screenArea(win);
        if (!this._isLikelyTiled(rect, area))
            return;

        this._cancelMonitorGeometryJobs(win);
        this._stopLiveResize();

        this._grab = {
            win,
            start: {...rect},
            last: {...rect},
        };

        this._liveResizeTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            LIVE_RESIZE_INTERVAL_MS,
            () => {
                if (!this._grab?.win)
                    return GLib.SOURCE_REMOVE;

                const current = this._rect(this._grab.win);
                if (!current)
                    return GLib.SOURCE_CONTINUE;

                this._reflowManualResize(
                    this._grab.win,
                    this._grab.last,
                    current
                );

                this._grab.last = {...current};
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _onGrabEnd(win) {
        if (!this._grab || this._grab.win !== win)
            return;

        const last = this._grab.last;
        const current = this._rect(win);

        if (current)
            this._reflowManualResize(win, last, current);

        this._stopLiveResize();
        this._grab = null;
    }

    _stopLiveResize() {
        if (!this._liveResizeTimer)
            return;

        try {
            GLib.Source.remove(this._liveResizeTimer);
        } catch (_) {
        }

        this._liveResizeTimer = 0;
    }

    _reflowManualResize(win, before, current) {
        if (!before || !current)
            return;

        const widthChanged = Math.abs(current.width - before.width) >= RESIZE_TOLERANCE;
        const heightChanged = Math.abs(current.height - before.height) >= RESIZE_TOLERANCE;

        if (!widthChanged && !heightChanged)
            return;

        const area = this._screenArea(win);
        if (!this._isLikelyTiled(current, area))
            return;

        const b = this._bounds(area);
        const side = this._side(current, area);
        const vertical = this._verticalSlot(current, area);
        const fullHeight = this._isFullHeight(current, area);
        const peers = this._entries(win, area);
        const same = this._entriesOnSide(peers, side);
        const opposite = this._entriesOnSide(peers, this._oppositeSide(side));
        const plan = new Map();

        let currentColumn = this._columnRegionFromRect(current, area);

        if (widthChanged) {
            let boundary;
            let leftRegion;
            let rightRegion;

            if (side === 'left') {
                boundary = Math.max(
                    b.left + MIN_REGION_SIZE,
                    Math.min(
                        b.right - INNER_GAP - MIN_REGION_SIZE,
                        current.x + current.width
                    )
                );

                leftRegion = {
                    x: b.left,
                    y: b.top,
                    width: boundary - b.left,
                    height: b.bottom - b.top,
                };
                rightRegion = {
                    x: boundary + INNER_GAP,
                    y: b.top,
                    width: b.right - boundary - INNER_GAP,
                    height: b.bottom - b.top,
                };
            } else {
                boundary = Math.max(
                    b.left + MIN_REGION_SIZE + INNER_GAP,
                    Math.min(
                        b.right - MIN_REGION_SIZE,
                        current.x
                    )
                );

                leftRegion = {
                    x: b.left,
                    y: b.top,
                    width: boundary - INNER_GAP - b.left,
                    height: b.bottom - b.top,
                };
                rightRegion = {
                    x: boundary,
                    y: b.top,
                    width: b.right - boundary,
                    height: b.bottom - b.top,
                };
            }

            currentColumn = side === 'left' ? leftRegion : rightRegion;
            const otherColumn = side === 'left' ? rightRegion : leftRegion;

            // Windows stacked with the one being resized inherit its x/width,
            // while their vertical divider remains where the user left it.
            for (const entry of same) {
                this._pushMove(plan, entry.win, {
                    x: currentColumn.x,
                    y: entry.rect.y,
                    width: currentColumn.width,
                    height: entry.rect.height,
                });
            }

            // The opposite column consumes every remaining horizontal pixel.
            this._fitVertical(plan, opposite, otherColumn);
        }

        if (heightChanged && !fullHeight) {
            const sibling = same.find(
                entry => !entry.fullHeight && entry.vertical !== vertical
            );

            if (sibling) {
                if (vertical === 'top') {
                    const y = current.y + current.height + INNER_GAP;
                    const height = b.bottom - y;

                    if (height >= MIN_REGION_SIZE) {
                        this._pushMove(plan, sibling.win, {
                            x: currentColumn.x,
                            y,
                            width: currentColumn.width,
                            height,
                        });
                    }
                } else {
                    const height = current.y - INNER_GAP - b.top;

                    if (height >= MIN_REGION_SIZE) {
                        this._pushMove(plan, sibling.win, {
                            x: currentColumn.x,
                            y: b.top,
                            width: currentColumn.width,
                            height,
                        });
                    }
                }
            }
        }

        this._executePlan(plan, `manual-resize-${side}`);
    }

    // ---------------------------------------------------------
    // Geometry engine
    // ---------------------------------------------------------

    _matches(actual, target) {
        return (
            Math.abs(actual.x - target.x) <= GEOMETRY_TOLERANCE &&
            Math.abs(actual.y - target.y) <= GEOMETRY_TOLERANCE &&
            Math.abs(actual.width - target.width) <= GEOMETRY_TOLERANCE &&
            Math.abs(actual.height - target.height) <= GEOMETRY_TOLERANCE
        );
    }

    _requestGeometry(win, rect) {
        if (!this._isSupportedWindow(win))
            return;

        const id = win.get_id();
        const target = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
        };

        this._cancelGeometryJob(win);
        this._pendingRects.set(id, target);

        try {
            if (win.is_maximized())
                win.unmaximize();
        } catch (_) {
        }

        let attempts = 0;

        const apply = () => {
            if (!this._isSupportedWindow(win)) {
                this._pendingRects.delete(id);
                this._geometryTimers.delete(id);
                return GLib.SOURCE_REMOVE;
            }

            try {
                win.move_resize_frame(
                    true,
                    target.x,
                    target.y,
                    target.width,
                    target.height
                );
            } catch (error) {
                console.error(`[Smart Arrow Tiling] move_resize_frame failed: ${error}`);
                this._pendingRects.delete(id);
                this._geometryTimers.delete(id);
                return GLib.SOURCE_REMOVE;
            }

            attempts += 1;
            const actual = this._rect(win);

            if (actual && this._matches(actual, target)) {
                this._pendingRects.delete(id);
                this._geometryTimers.delete(id);
                return GLib.SOURCE_REMOVE;
            }

            if (attempts >= GEOMETRY_RETRY_MAX) {
                this._pendingRects.delete(id);
                this._geometryTimers.delete(id);
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        };

        // Apply immediately, then retry briefly because unmaximize and some
        // Wayland clients may settle asynchronously.
        try {
            win.move_resize_frame(
                true,
                target.x,
                target.y,
                target.width,
                target.height
            );
        } catch (_) {
        }

        const sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            GEOMETRY_RETRY_MS,
            apply
        );

        this._geometryTimers.set(id, sourceId);
    }

    _cancelMonitorGeometryJobs(win) {
        const workspace = win?.get_workspace?.();
        const monitor = win?.get_monitor?.();

        if (!workspace || monitor === undefined)
            return;

        for (const peer of workspace.list_windows()) {
            if (peer.get_monitor() === monitor)
                this._cancelGeometryJob(peer);
        }
    }

    _cancelGeometryJob(win) {
        if (!win || !this._geometryTimers)
            return;

        const id = win.get_id();
        const sourceId = this._geometryTimers.get(id);

        if (sourceId !== undefined) {
            try {
                GLib.Source.remove(sourceId);
            } catch (_) {
            }
            this._geometryTimers.delete(id);
        }

        this._pendingRects?.delete(id);
    }
}
