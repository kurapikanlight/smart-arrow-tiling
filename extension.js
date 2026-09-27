import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const VERSION = '10.0-gapless-linked-reflow';

const SEQUENCE_TIMEOUT_MS = 750;
const MULTIKEY_DELAY_MS = 320;
const MANUAL_REFLOW_DELAY_MS = 40;
const LIVE_REFLOW_INTERVAL_MS = 24;

const OUTER_GAP = 1;
const INNER_GAP = 1;

const EDGE_TOLERANCE = 90;
const FULL_HEIGHT_RATIO = 0.72;
const GEOMETRY_TOLERANCE = 6;
const RESIZE_CHANGE_TOLERANCE = 3;
const MIN_REGION_SIZE = 80;

const CONVERGE_INTERVAL_MS = 25;
const CONVERGE_MAX_ATTEMPTS = 60;

const ANIMATIONS_ENABLED = true;
const ANIMATION_MS = 135;

export default class SmartArrowTilingExtension extends Extension {
    enable() {
        console.log(`[Smart Arrow Tiling] ENABLE ${VERSION}`);

        this._settings = this.getSettings();

        this._mutterKeys = new Gio.Settings({
            schema_id: 'org.gnome.mutter.keybindings',
        });

        this._wmKeys = new Gio.Settings({
            schema_id: 'org.gnome.desktop.wm.keybindings',
        });

        this._lastHorizontal = null;
        this._lastHorizontalAt = 0;
        this._lastWindowId = null;

        this._delayedHorizontal = null;
        this._delayedHorizontalTimer = null;

        this._pending = new Map();
        this._timers = new Map();
        this._animatedActors = new Set();

        this._grabStarts = new Map();
        this._grabLastRects = new Map();
        this._manualReflowTimers = new Map();
        this._grabLiveSignals = new Map();

        this._saveAndDisableNativeBindings();

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

        Main.wm.addKeybinding(
            'tile-up',
            this._settings,
            flags,
            mode,
            () => this._onVertical('up')
        );

        Main.wm.addKeybinding(
            'tile-down',
            this._settings,
            flags,
            mode,
            () => this._onVertical('down')
        );

        /*
         * Manual resizing support.
         *
         * We deliberately compare the frame before/after the grab instead of
         * depending on Meta.GrabOp enum names. This makes the logic robust:
         * pure moves are ignored, actual resizes trigger complementary reflow.
         */
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
        this._clearDelayedHorizontal(false);

        for (const name of [
            'tile-left',
            'tile-right',
            'tile-up',
            'tile-down',
        ]) {
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

        this._stopAll();
        this._disconnectAllGrabLiveSignals();
        this._stopAllManualReflowTimers();
        this._resetAllActorAnimations();
        this._restoreNativeBindings();

        this._settings = null;
        this._mutterKeys = null;
        this._wmKeys = null;

        this._pending = null;
        this._timers = null;
        this._animatedActors = null;
        this._grabStarts = null;
        this._grabLastRects = null;
        this._manualReflowTimers = null;
        this._grabLiveSignals = null;

        this._clearSequence();

        console.log(`[Smart Arrow Tiling] DISABLE ${VERSION}`);
    }

    // =========================================================
    // GNOME native keybindings
    // =========================================================

    _saveAndDisableNativeBindings() {
        if (!this._settings.get_boolean('originals-saved')) {
            let left = this._mutterKeys.get_strv('toggle-tiled-left');
            let right = this._mutterKeys.get_strv('toggle-tiled-right');
            let up = this._wmKeys.get_strv('maximize');
            let down = this._wmKeys.get_strv('minimize');

            if (!left.length)
                left = ['<Super>Left'];
            if (!right.length)
                right = ['<Super>Right'];
            if (!up.length)
                up = ['<Super>Up'];
            if (!down.length)
                down = ['<Super>Down'];

            this._settings.set_strv('saved-tiled-left', left);
            this._settings.set_strv('saved-tiled-right', right);
            this._settings.set_strv('saved-maximize', up);
            this._settings.set_strv('saved-minimize', down);
            this._settings.set_boolean('originals-saved', true);
        }

        this._mutterKeys.set_strv('toggle-tiled-left', []);
        this._mutterKeys.set_strv('toggle-tiled-right', []);
        this._wmKeys.set_strv('maximize', []);
        this._wmKeys.set_strv('minimize', []);
    }

    _restoreNativeBindings() {
        if (!this._settings?.get_boolean('originals-saved'))
            return;

        let left = this._settings.get_strv('saved-tiled-left');
        let right = this._settings.get_strv('saved-tiled-right');
        let up = this._settings.get_strv('saved-maximize');
        let down = this._settings.get_strv('saved-minimize');

        if (!left.length)
            left = ['<Super>Left'];
        if (!right.length)
            right = ['<Super>Right'];
        if (!up.length)
            up = ['<Super>Up'];
        if (!down.length)
            down = ['<Super>Down'];

        this._mutterKeys.set_strv('toggle-tiled-left', left);
        this._mutterKeys.set_strv('toggle-tiled-right', right);
        this._wmKeys.set_strv('maximize', up);
        this._wmKeys.set_strv('minimize', down);

        this._settings.set_boolean('originals-saved', false);
    }

    // =========================================================
    // Focus / supported windows
    // =========================================================

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

    // =========================================================
    // Sequence state
    // =========================================================

    _now() {
        return GLib.get_monotonic_time() / 1000;
    }

    _rememberHorizontal(win, direction) {
        this._lastHorizontal = direction;
        this._lastHorizontalAt = this._now();
        this._lastWindowId = win.get_id();
    }

    _hasFreshHorizontal(win) {
        return (
            this._lastHorizontal !== null &&
            this._lastWindowId === win.get_id() &&
            this._now() - this._lastHorizontalAt <= SEQUENCE_TIMEOUT_MS
        );
    }

    _clearSequence() {
        this._lastHorizontal = null;
        this._lastHorizontalAt = 0;
        this._lastWindowId = null;
    }

    // =========================================================
    // Delayed horizontal press
    // =========================================================

    _clearDelayedHorizontal(execute = false) {
        const pending = this._delayedHorizontal;

        if (this._delayedHorizontalTimer !== null) {
            try {
                GLib.Source.remove(this._delayedHorizontalTimer);
            } catch (_) {
            }

            this._delayedHorizontalTimer = null;
        }

        this._delayedHorizontal = null;

        if (execute && pending?.win)
            this._executeDelayedHorizontal(pending);
    }

    _scheduleHorizontal(win, direction, kind) {
        this._clearDelayedHorizontal(false);

        this._delayedHorizontal = {
            win,
            direction,
            kind,
            originRect: {...win.get_frame_rect()},
        };

        this._rememberHorizontal(win, direction);

        this._delayedHorizontalTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            MULTIKEY_DELAY_MS,
            () => {
                const pending = this._delayedHorizontal;

                this._delayedHorizontal = null;
                this._delayedHorizontalTimer = null;

                if (pending?.win)
                    this._executeDelayedHorizontal(pending);

                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _executeDelayedHorizontal(pending) {
        if (!pending?.win)
            return;

        if (pending.kind === 'floating') {
            this._snapFloatingHalfSmart(
                pending.win,
                pending.direction,
                pending.originRect
            );
        } else {
            this._tileHalfSmart(
                pending.win,
                pending.direction
            );
        }
    }

    // =========================================================
    // Horizontal key
    // =========================================================

    _onHorizontal(direction) {
        const win = this._focusedWindow();

        if (!win)
            return;

        /*
         * A delayed first press followed by the same horizontal key is
         * the 1/3 command.
         */
        if (
            this._delayedHorizontal?.win === win &&
            this._delayedHorizontal.direction === direction
        ) {
            this._clearDelayedHorizontal(false);

            this._tileThirdSmart(
                win,
                direction
            );

            this._clearSequence();

            return;
        }

        /*
         * Flush an unrelated delayed action before accepting a new one.
         */
        if (this._delayedHorizontal) {
            const pending =
                this._delayedHorizontal;

            this._clearDelayedHorizontal(false);

            this._executeDelayedHorizontal(
                pending
            );
        }

        /*
         * Full-height/immediate paths still support double Left/Right.
         */
        if (
            this._hasFreshHorizontal(win) &&
            this._lastHorizontal === direction
        ) {
            this._tileThirdSmart(
                win,
                direction
            );

            this._clearSequence();

            return;
        }

        const area =
            this._screenArea(win);

        const rect =
            this._effectiveRect(win);

        const tiled =
            this._isLikelyTiled(
                rect,
                area
            );

        /*
         * Floating/new windows are delayed so a two-key quarter command
         * is interpreted atomically.
         */
        if (!tiled) {
            this._scheduleHorizontal(
                win,
                direction,
                'floating'
            );

            return;
        }

        const side =
            this._dominantSide(
                rect,
                area
            );

        const fullHeight =
            this._isFullHeight(
                rect,
                area
            );

        /*
         * Any PARTIAL window gets a short delay before crossing columns.
         * This is the important diagonal-swap fix:
         *
         *   A B        D B
         *   C D   ->   C A
         *
         * Right+Down on A is planned as one operation instead of first
         * swapping A/B and then moving A on top of D.
         */
        if (
            !fullHeight &&
            side !== direction
        ) {
            this._scheduleHorizontal(
                win,
                direction,
                'cross'
            );

            return;
        }

        /*
         * Existing top/bottom stack on the same side: delay so
         * Left/Right + Up/Down can swap the vertical slots atomically.
         */
        if (
            !fullHeight &&
            side === direction &&
            this._hasStackSibling(
                win,
                area,
                side
            )
        ) {
            this._scheduleHorizontal(
                win,
                direction,
                'stack'
            );

            return;
        }

        this._tileHalfSmart(
            win,
            direction
        );

        this._rememberHorizontal(
            win,
            direction
        );
    }

    // =========================================================
    // Vertical key
    // =========================================================

    _onVertical(direction) {
        const win =
            this._focusedWindow();

        if (!win)
            return;

        if (
            this._delayedHorizontal?.win
            === win
        ) {
            const pending =
                this._delayedHorizontal;

            this._clearDelayedHorizontal(
                false
            );

            /*
             * Floating/new centered window: insert directly into the
             * requested quarter without an intermediate half swap.
             */
            if (
                pending.kind === 'floating'
            ) {
                this._insertFloatingQuarter(
                    win,
                    pending.direction,
                    direction,
                    pending.originRect
                );

                this._clearSequence();

                return;
            }

            /*
             * Partial window crossing columns: resolve the final slot in
             * one plan. This makes diagonal A<->D style swaps literal and
             * lets the vacated source column reflow at the same time.
             */
            if (
                pending.kind === 'cross'
            ) {
                const vertical =
                    direction === 'up'
                        ? 'top'
                        : 'bottom';

                this._movePartialAcrossSides(
                    win,
                    pending.direction,
                    vertical,
                    pending.originRect,
                    'atomic-cross-quarter'
                );

                this._clearSequence();

                return;
            }

            /*
             * Existing stacked pair: same-side + Up/Down swaps top/bottom.
             */
            if (
                pending.kind === 'stack'
            ) {
                this._tryVerticalStackSwap(
                    win,
                    pending.direction,
                    direction
                );

                this._clearSequence();

                return;
            }

            this._tileQuarter(
                win,
                pending.direction,
                direction
            );

            this._clearSequence();

            return;
        }

        if (
            this._hasFreshHorizontal(win)
        ) {
            const horizontal =
                this._lastHorizontal;

            const area =
                this._screenArea(win);

            const rect =
                this._effectiveRect(win);

            /*
             * If the horizontal operation left us in a real stack, swap
             * the slot instead of blindly placing one window over another.
             */
            if (
                !this._isFullHeight(rect, area) &&
                this._tryVerticalStackSwap(
                    win,
                    horizontal,
                    direction
                )
            ) {
                this._clearSequence();
                return;
            }

            /*
             * Do not turn the only full-height window in a column into a
             * lone quarter; that would deliberately create a black hole.
             */
            if (
                this._isFullHeight(rect, area)
            ) {
                this._clearSequence();
                return;
            }

            this._tileQuarter(
                win,
                horizontal,
                direction
            );

            this._clearSequence();

            return;
        }

        this._clearSequence();

        this._cancelJob(
            win
        );

        this._resetActorAnimation(
            win
        );

        try {
            if (
                direction === 'up'
            ) {
                if (
                    win.can_maximize()
                ) {
                    win.maximize();
                }
            } else if (
                win.can_minimize()
            ) {
                win.minimize();
            }

        } catch (error) {
            console.error(
                `[Smart Arrow Tiling] vertical action failed: ${error}`
            );
        }
    }

    // =========================================================
    // Monitor geometry
    // =========================================================

    _screenArea(win) {
        /*
         * Use the real logical monitor geometry, not GNOME's work area.
         * Auto-hidden docks/panels can reserve invisible work-area space.
         */
        return global.display.get_monitor_geometry(
            win.get_monitor()
        );
    }

    _innerBounds(area) {
        return {
            left:
                area.x + OUTER_GAP,

            top:
                area.y + OUTER_GAP,

            right:
                area.x
                + area.width
                - OUTER_GAP,

            bottom:
                area.y
                + area.height
                - OUTER_GAP,
        };
    }

    _opposite(side) {
        return (
            side === 'left'
                ? 'right'
                : 'left'
        );
    }

    // =========================================================
    // Canonical geometry
    // =========================================================

    _halves(area) {
        const x =
            area.x + OUTER_GAP;

        const y =
            area.y + OUTER_GAP;

        const height =
            Math.max(
                1,
                area.height
                - OUTER_GAP * 2
            );

        const usable =
            Math.max(
                2,
                area.width
                - OUTER_GAP * 2
                - INNER_GAP
            );

        const leftWidth =
            Math.floor(
                usable / 2
            );

        const rightWidth =
            usable - leftWidth;

        return {
            left: {
                x,
                y,
                width:
                    leftWidth,
                height,
            },

            right: {
                x:
                    x
                    + leftWidth
                    + INNER_GAP,

                y,

                width:
                    rightWidth,

                height,
            },
        };
    }

    _quarter(
        area,
        side,
        vertical
    ) {
        const half =
            this._halves(
                area
            )[side];

        const usable =
            Math.max(
                2,
                half.height
                - INNER_GAP
            );

        const topHeight =
            Math.floor(
                usable / 2
            );

        const bottomHeight =
            usable
            - topHeight;

        if (
            vertical === 'top'
        ) {
            return {
                x:
                    half.x,

                y:
                    half.y,

                width:
                    half.width,

                height:
                    topHeight,
            };
        }

        return {
            x:
                half.x,

            y:
                half.y
                + topHeight
                + INNER_GAP,

            width:
                half.width,

            height:
                bottomHeight,
        };
    }

    _thirdPair(
        area,
        direction
    ) {
        const x =
            area.x + OUTER_GAP;

        const y =
            area.y + OUTER_GAP;

        const height =
            Math.max(
                1,
                area.height
                - OUTER_GAP * 2
            );

        const usable =
            Math.max(
                3,
                area.width
                - OUTER_GAP * 2
                - INNER_GAP
            );

        const oneThird =
            Math.round(
                usable / 3
            );

        const twoThird =
            usable - oneThird;

        if (
            direction === 'left'
        ) {
            return {
                current: {
                    x,
                    y,
                    width:
                        oneThird,
                    height,
                },

                complement: {
                    x:
                        x
                        + oneThird
                        + INNER_GAP,

                    y,

                    width:
                        twoThird,

                    height,
                },
            };
        }

        return {
            complement: {
                x,
                y,
                width:
                    twoThird,
                height,
            },

            current: {
                x:
                    x
                    + twoThird
                    + INNER_GAP,

                y,

                width:
                    oneThird,

                height,
            },
        };
    }

    // =========================================================
    // Layout recognition
    // =========================================================

    _effectiveRect(win) {
        return (
            this._pending
                ?.get(
                    win.get_id()
                )
                ?.rect
            ??
            win.get_frame_rect()
        );
    }

    _intersectionWidth(
        a,
        b
    ) {
        return Math.max(
            0,

            Math.min(
                a.x + a.width,
                b.x + b.width
            )

            -

            Math.max(
                a.x,
                b.x
            )
        );
    }

    _intersectionHeight(
        a,
        b
    ) {
        return Math.max(
            0,

            Math.min(
                a.y + a.height,
                b.y + b.height
            )

            -

            Math.max(
                a.y,
                b.y
            )
        );
    }

    _dominantSide(
        rect,
        area
    ) {
        const halves =
            this._halves(area);

        const leftOverlap =
            this._intersectionWidth(
                rect,
                halves.left
            );

        const rightOverlap =
            this._intersectionWidth(
                rect,
                halves.right
            );

        if (
            leftOverlap
            === rightOverlap
        ) {
            return (
                rect.x
                + rect.width / 2
                <
                area.x
                + area.width / 2

                    ? 'left'
                    : 'right'
            );
        }

        return (
            leftOverlap
            > rightOverlap

                ? 'left'
                : 'right'
        );
    }

    _edgeSide(
        rect,
        area
    ) {
        const bounds =
            this._innerBounds(
                area
            );

        const leftDistance =
            Math.abs(
                rect.x
                - bounds.left
            );

        const rightDistance =
            Math.abs(
                rect.x
                + rect.width
                - bounds.right
            );

        if (
            leftDistance <= EDGE_TOLERANCE &&
            leftDistance <= rightDistance
        ) {
            return 'left';
        }

        if (
            rightDistance <= EDGE_TOLERANCE
        ) {
            return 'right';
        }

        return this._dominantSide(
            rect,
            area
        );
    }

    _verticalSlot(
        rect,
        area
    ) {
        const side =
            this._dominantSide(
                rect,
                area
            );

        const top =
            this._quarter(
                area,
                side,
                'top'
            );

        const bottom =
            this._quarter(
                area,
                side,
                'bottom'
            );

        const topOverlap =
            this._intersectionHeight(
                rect,
                top
            );

        const bottomOverlap =
            this._intersectionHeight(
                rect,
                bottom
            );

        if (
            topOverlap
            === bottomOverlap
        ) {
            return (
                rect.y
                + rect.height / 2
                <
                area.y
                + area.height / 2

                    ? 'top'
                    : 'bottom'
            );
        }

        return (
            topOverlap
            > bottomOverlap

                ? 'top'
                : 'bottom'
        );
    }

    _isFullHeight(
        rect,
        area
    ) {
        const usable =
            Math.max(
                1,
                area.height
                - OUTER_GAP * 2
            );

        return (
            rect.height
            / usable
            >= FULL_HEIGHT_RATIO
        );
    }

    _isLikelyTiled(
        rect,
        area
    ) {
        const bounds =
            this._innerBounds(
                area
            );

        const touchesVerticalEdge =
            Math.abs(
                rect.x
                - bounds.left
            ) <= EDGE_TOLERANCE

            ||

            Math.abs(
                rect.x
                + rect.width
                - bounds.right
            ) <= EDGE_TOLERANCE;

        const touchesHorizontalEdge =
            Math.abs(
                rect.y
                - bounds.top
            ) <= EDGE_TOLERANCE

            ||

            Math.abs(
                rect.y
                + rect.height
                - bounds.bottom
            ) <= EDGE_TOLERANCE;

        return (
            touchesVerticalEdge
            &&
            touchesHorizontalEdge
            &&
            rect.width
            >= area.width * 0.20
            &&
            rect.height
            >= area.height * 0.25
        );
    }

    _candidateEntries(
        current,
        area
    ) {
        const workspace =
            current.get_workspace();

        const monitor =
            current.get_monitor();

        const result = [];

        for (
            const win
            of workspace.list_windows()
        ) {
            if (
                win === current
                ||
                win.get_monitor() !== monitor
                ||
                win.is_hidden()
                ||
                win.is_fullscreen()
                ||
                !this._isSupportedWindow(win)
            ) {
                continue;
            }

            const rect =
                this._effectiveRect(
                    win
                );

            if (
                !this._isLikelyTiled(
                    rect,
                    area
                )
            ) {
                continue;
            }

            result.push({
                win,
                rect,

                side:
                    this._dominantSide(
                        rect,
                        area
                    ),

                vertical:
                    this._verticalSlot(
                        rect,
                        area
                    ),

                fullHeight:
                    this._isFullHeight(
                        rect,
                        area
                    ),
            });
        }

        return result;
    }

    _entriesOnSide(
        entries,
        side
    ) {
        return entries
            .filter(
                entry =>
                    entry.side
                    === side
            )
            .sort(
                (a, b) =>
                    a.rect.y
                    - b.rect.y
            );
    }

    _unionRect(entries) {
        if (!entries.length)
            return null;

        let left =
            Infinity;

        let top =
            Infinity;

        let right =
            -Infinity;

        let bottom =
            -Infinity;

        for (
            const entry
            of entries
        ) {
            left =
                Math.min(
                    left,
                    entry.rect.x
                );

            top =
                Math.min(
                    top,
                    entry.rect.y
                );

            right =
                Math.max(
                    right,
                    entry.rect.x
                    + entry.rect.width
                );

            bottom =
                Math.max(
                    bottom,
                    entry.rect.y
                    + entry.rect.height
                );
        }

        return {
            x:
                Math.round(left),

            y:
                Math.round(top),

            width:
                Math.round(
                    right - left
                ),

            height:
                Math.round(
                    bottom - top
                ),
        };
    }

    _hasStackSibling(
        win,
        area,
        side
    ) {
        const currentRect =
            this._effectiveRect(
                win
            );

        if (
            this._isFullHeight(
                currentRect,
                area
            )
        ) {
            return false;
        }

        const currentVertical =
            this._verticalSlot(
                currentRect,
                area
            );

        const peers =
            this._entriesOnSide(
                this._candidateEntries(
                    win,
                    area
                ),
                side
            );

        return peers.some(
            entry =>
                !entry.fullHeight
                &&
                entry.vertical
                !== currentVertical
        );
    }

    // =========================================================
    // Movement plans
    // =========================================================

    _pushMove(
        plan,
        win,
        rect
    ) {
        if (
            win
            &&
            rect
        ) {
            plan.push({
                win,
                rect,
            });
        }
    }

    _fitWindowsIntoRegion(
        plan,
        entries,
        region
    ) {
        if (!entries.length)
            return;

        if (
            region.width < MIN_REGION_SIZE
            ||
            region.height < MIN_REGION_SIZE
        ) {
            return;
        }

        if (
            entries.length === 1
        ) {
            this._pushMove(
                plan,
                entries[0].win,
                region
            );

            return;
        }

        if (
            entries.length !== 2
        ) {
            return;
        }

        const sorted =
            [...entries]
                .sort(
                    (a, b) =>
                        a.rect.y
                        - b.rect.y
                );

        const usableHeight =
            Math.max(
                2,
                region.height
                - INNER_GAP
            );

        const existingTotal =
            Math.max(
                2,
                sorted[0].rect.height
                +
                sorted[1].rect.height
            );

        let topHeight =
            Math.round(
                usableHeight
                *
                sorted[0].rect.height
                /
                existingTotal
            );

        const minimumSplit =
            usableHeight >= MIN_REGION_SIZE * 2
                ? MIN_REGION_SIZE
                : 1;

        topHeight =
            Math.max(
                minimumSplit,
                Math.min(
                    usableHeight - minimumSplit,
                    topHeight
                )
            );

        const bottomHeight =
            usableHeight
            - topHeight;

        this._pushMove(
            plan,
            sorted[0].win,
            {
                x:
                    region.x,

                y:
                    region.y,

                width:
                    region.width,

                height:
                    topHeight,
            }
        );

        this._pushMove(
            plan,
            sorted[1].win,
            {
                x:
                    region.x,

                y:
                    region.y
                    + topHeight
                    + INNER_GAP,

                width:
                    region.width,

                height:
                    bottomHeight,
            }
        );
    }

    _layoutRegionsFromSource(
        area,
        sourceSide,
        sourceEntries
    ) {
        const bounds =
            this._innerBounds(area);

        const halves =
            this._halves(area);

        if (!sourceEntries.length)
            return halves;

        let splitX;

        if (sourceSide === 'left') {
            const sourceRight =
                Math.max(
                    ...sourceEntries.map(
                        entry =>
                            entry.rect.x
                            + entry.rect.width
                    )
                );

            splitX =
                Math.round(sourceRight);

        } else {
            const sourceLeft =
                Math.min(
                    ...sourceEntries.map(
                        entry =>
                            entry.rect.x
                    )
                );

            splitX =
                Math.round(
                    sourceLeft
                    - INNER_GAP
                );
        }

        splitX =
            Math.max(
                bounds.left + MIN_REGION_SIZE,
                Math.min(
                    bounds.right
                    - INNER_GAP
                    - MIN_REGION_SIZE,
                    splitX
                )
            );

        return {
            left: {
                x:
                    bounds.left,

                y:
                    bounds.top,

                width:
                    splitX
                    - bounds.left,

                height:
                    bounds.bottom
                    - bounds.top,
            },

            right: {
                x:
                    splitX
                    + INNER_GAP,

                y:
                    bounds.top,

                width:
                    bounds.right
                    - splitX
                    - INNER_GAP,

                height:
                    bounds.bottom
                    - bounds.top,
            },
        };
    }

    _splitVerticalRegion(
        region,
        topFraction = 0.5
    ) {
        const usable =
            Math.max(
                2,
                region.height
                - INNER_GAP
            );

        const minFraction =
            Math.min(
                0.45,
                MIN_REGION_SIZE
                / Math.max(1, usable)
            );

        const fraction =
            Math.max(
                minFraction,
                Math.min(
                    1 - minFraction,
                    topFraction
                )
            );

        let topHeight =
            Math.round(
                usable
                * fraction
            );

        topHeight =
            Math.max(
                1,
                Math.min(
                    usable - 1,
                    topHeight
                )
            );

        const bottomHeight =
            usable
            - topHeight;

        return {
            top: {
                x:
                    region.x,

                y:
                    region.y,

                width:
                    region.width,

                height:
                    topHeight,
            },

            bottom: {
                x:
                    region.x,

                y:
                    region.y
                    + topHeight
                    + INNER_GAP,

                width:
                    region.width,

                height:
                    bottomHeight,
            },
        };
    }

    _entryWithRect(
        entry,
        rect
    ) {
        return {
            ...entry,
            rect: {
                ...rect,
            },
        };
    }

    _movePartialAcrossSides(
        win,
        targetSide,
        targetVertical,
        originRect = null,
        label = 'partial-cross'
    ) {
        const area =
            this._screenArea(win);

        const currentRect =
            originRect
            ? {...originRect}
            : {...this._effectiveRect(win)};

        const sourceSide =
            this._dominantSide(
                currentRect,
                area
            );

        if (
            sourceSide === targetSide
        ) {
            const verticalKey =
                targetVertical === 'top'
                    ? 'up'
                    : 'down';

            if (
                this._tryVerticalStackSwap(
                    win,
                    targetSide,
                    verticalKey
                )
            ) {
                return;
            }

            return;
        }

        const currentVertical =
            this._verticalSlot(
                currentRect,
                area
            );

        const currentEntry = {
            win,
            rect: {
                ...currentRect,
            },
            side:
                sourceSide,
            vertical:
                currentVertical,
            fullHeight:
                false,
        };

        const peers =
            this._candidateEntries(
                win,
                area
            );

        const sourceOthers =
            this._entriesOnSide(
                peers,
                sourceSide
            );

        const destination =
            this._entriesOnSide(
                peers,
                targetSide
            );

        const oldSourceGroup =
            [
                currentEntry,
                ...sourceOthers,
            ];

        const regions =
            this._layoutRegionsFromSource(
                area,
                sourceSide,
                oldSourceGroup
            );

        const sourceRegion =
            regions[sourceSide];

        const targetRegion =
            regions[targetSide];

        let victim = null;

        if (
            destination.length >= 2
        ) {
            victim =
                destination.find(
                    entry =>
                        !entry.fullHeight
                        && entry.vertical
                        === targetVertical
                )
                ?? destination.find(
                    entry =>
                        entry.vertical
                        === targetVertical
                )
                ?? destination[0];

        } else if (
            destination.length === 1
            && !destination[0].fullHeight
            && destination[0].vertical
            === targetVertical
        ) {
            victim =
                destination[0];
        }

        const sourceAfter =
            [...sourceOthers];

        const targetAfter =
            destination.filter(
                entry =>
                    entry !== victim
            );

        if (victim) {
            sourceAfter.push(
                this._entryWithRect(
                    victim,
                    currentRect
                )
            );
        }

        let sourceTopFraction =
            0.5;

        const sourceUsableHeight =
            Math.max(
                2,
                sourceRegion.height
                - INNER_GAP
            );

        if (
            currentVertical === 'top'
        ) {
            sourceTopFraction =
                currentRect.height
                / sourceUsableHeight;
        } else {
            sourceTopFraction =
                1
                - currentRect.height
                / sourceUsableHeight;
        }

        const targetSlots =
            this._splitVerticalRegion(
                targetRegion,
                sourceTopFraction
            );

        if (
            targetAfter.length === 1
        ) {
            targetAfter[0] =
                this._entryWithRect(
                    targetAfter[0],
                    targetSlots[
                        targetVertical === 'top'
                            ? 'bottom'
                            : 'top'
                    ]
                );
        }

        const currentTargetHint =
            victim
                ? victim.rect
                : targetSlots[targetVertical];

        targetAfter.push({
            ...currentEntry,
            rect: {
                ...currentTargetHint,
            },
            side:
                targetSide,
            vertical:
                targetVertical,
        });

        const plan = [];

        if (
            sourceAfter.length >= 1
            && sourceAfter.length <= 2
        ) {
            this._fitWindowsIntoRegion(
                plan,
                sourceAfter,
                sourceRegion
            );
        }

        if (
            targetAfter.length >= 1
            && targetAfter.length <= 2
        ) {
            this._fitWindowsIntoRegion(
                plan,
                targetAfter,
                targetRegion
            );
        }

        this._executePlan(
            plan,
            `${label}-${sourceSide}-to-${targetSide}-${targetVertical}`
        );
    }

    _executePlan(
        plan,
        label,
        animate = true
    ) {
        if (!plan.length)
            return;

        const deduplicated =
            new Map();

        for (
            const move
            of plan
        ) {
            deduplicated.set(
                move.win.get_id(),
                move
            );
        }

        const moves =
            [...deduplicated.values()];

        const starts =
            new Map();

        for (
            const move
            of moves
        ) {
            starts.set(
                move.win.get_id(),
                move.win.get_frame_rect()
            );
        }

        console.log(
            `[Smart Arrow Tiling] PLAN ${label}: ` +
            `${moves.length} window(s)`
        );

        for (
            const move
            of moves
        ) {
            this._requestGeometry(
                move.win,
                move.rect,
                starts.get(
                    move.win.get_id()
                ),
                animate
            );
        }
    }

    // =========================================================
    // Floating/new window route
    // =========================================================

    _snapFloatingHalfSmart(
        win,
        direction,
        originRect
    ) {
        const area =
            this._screenArea(
                win
            );

        const halves =
            this._halves(
                area
            );

        const peers =
            this._candidateEntries(
                win,
                area
            );

        const destination =
            this._entriesOnSide(
                peers,
                direction
            );

        const plan = [];

        /*
         * If that side is already occupied, exchange the whole destination
         * zone with the floating window's old rectangle.
         *
         * Common 2-window case:
         * existing right window -> old center rectangle
         * new window -> right tile
         */
        if (
            destination.length >= 1
            &&
            destination.length <= 2
        ) {
            const destinationRegion =
                this._unionRect(
                    destination
                );

            this._fitWindowsIntoRegion(
                plan,
                destination,
                originRect
            );

            this._pushMove(
                plan,
                win,
                destinationRegion
            );

            this._executePlan(
                plan,
                `floating-swap-to-${direction}`
            );

            return;
        }

        this._pushMove(
            plan,
            win,
            halves[direction]
        );

        this._executePlan(
            plan,
            `floating-snap-${direction}`
        );
    }

    _insertFloatingQuarter(
        win,
        horizontal,
        verticalKey,
        originRect
    ) {
        const area =
            this._screenArea(
                win
            );

        const vertical =
            verticalKey === 'up'
                ? 'top'
                : 'bottom';

        const oppositeVertical =
            vertical === 'top'
                ? 'bottom'
                : 'top';

        const requestedQuarter =
            this._quarter(
                area,
                horizontal,
                vertical
            );

        const oppositeQuarter =
            this._quarter(
                area,
                horizontal,
                oppositeVertical
            );

        const peers =
            this._candidateEntries(
                win,
                area
            );

        const destination =
            this._entriesOnSide(
                peers,
                horizontal
            );

        const plan = [];

        /*
         * Exact intended case:
         *
         * left half + right half + new centered window
         *
         * Super+Right,Up:
         * new window -> top-right
         * old right window -> bottom-right
         */
        if (
            destination.length === 1
            &&
            destination[0].fullHeight
        ) {
            this._pushMove(
                plan,
                destination[0].win,
                oppositeQuarter
            );

            this._pushMove(
                plan,
                win,
                requestedQuarter
            );

            this._executePlan(
                plan,
                `floating-insert-${horizontal}-${vertical}`
            );

            return;
        }

        /*
         * Existing two-window stack on the target side:
         * replace only the requested top/bottom slot and send the displaced
         * window to the new window's old floating rectangle.
         */
        if (
            destination.length === 2
        ) {
            const victim =
                destination.find(
                    entry =>
                        entry.vertical
                        === vertical
                )
                ??
                destination[0];

            this._pushMove(
                plan,
                victim.win,
                originRect
            );

            this._pushMove(
                plan,
                win,
                victim.rect
            );

            this._executePlan(
                plan,
                `floating-replace-${horizontal}-${vertical}`
            );

            return;
        }

        /*
         * A single partial target:
         * if it occupies the requested slot, exchange with it.
         * Otherwise simply fill the requested empty slot.
         */
        if (
            destination.length === 1
        ) {
            const victim =
                destination[0];

            if (
                !victim.fullHeight
                &&
                victim.vertical
                === vertical
            ) {
                this._pushMove(
                    plan,
                    victim.win,
                    originRect
                );

                this._pushMove(
                    plan,
                    win,
                    victim.rect
                );
            } else {
                this._pushMove(
                    plan,
                    win,
                    requestedQuarter
                );
            }

            this._executePlan(
                plan,
                `floating-quarter-${horizontal}-${vertical}`
            );

            return;
        }

        this._pushMove(
            plan,
            win,
            requestedQuarter
        );

        this._executePlan(
            plan,
            `floating-quarter-empty-${horizontal}-${vertical}`
        );
    }

    // =========================================================
    // Smart half / side swap
    // =========================================================

    _tileHalfSmart(
        win,
        direction
    ) {
        const area =
            this._screenArea(
                win
            );

        const halves =
            this._halves(
                area
            );

        const currentRect =
            this._effectiveRect(
                win
            );

        const sourceSide =
            this._dominantSide(
                currentRect,
                area
            );

        const currentFull =
            this._isFullHeight(
                currentRect,
                area
            );

        const peers =
            this._candidateEntries(
                win,
                area
            );

        const plan = [];

        /*
         * Same side: normalize a full-height/third layout. A partial window
         * that belongs to a stack is normally delayed by _onHorizontal(),
         * so it does not destroy its sibling layout here.
         */
        if (
            sourceSide === direction
        ) {
            if (!currentFull) {
                return;
            }

            const opposite =
                this._opposite(
                    direction
                );

            const oppositeEntries =
                this._entriesOnSide(
                    peers,
                    opposite
                );

            if (
                oppositeEntries.length >= 1
                && oppositeEntries.length <= 2
            ) {
                this._fitWindowsIntoRegion(
                    plan,
                    oppositeEntries,
                    halves[opposite]
                );
            }

            this._pushMove(
                plan,
                win,
                halves[direction]
            );

            this._executePlan(
                plan,
                `normalize-${direction}-50-50`
            );

            return;
        }

        /*
         * Partial windows use one shared reflow planner. It keeps the
         * existing column divider, swaps the requested slot when occupied,
         * expands a lone survivor to full height, and never leaves the
         * vacated slot black.
         */
        if (!currentFull) {
            const vertical =
                this._verticalSlot(
                    currentRect,
                    area
                );

            this._movePartialAcrossSides(
                win,
                direction,
                vertical,
                currentRect,
                'horizontal-cross'
            );

            return;
        }

        const destination =
            this._entriesOnSide(
                peers,
                direction
            );

        /*
         * Full-height column crosses to the other side. Use the existing
         * divider as the source of truth so a partial destination is first
         * normalized to a full column instead of preserving a black hole.
         */
        const currentEntry = {
            win,
            rect: {
                ...currentRect,
            },
        };

        const regions =
            this._layoutRegionsFromSource(
                area,
                sourceSide,
                [currentEntry]
            );

        if (
            destination.length >= 1
            && destination.length <= 2
        ) {
            this._fitWindowsIntoRegion(
                plan,
                destination,
                regions[sourceSide]
            );

            this._pushMove(
                plan,
                win,
                regions[direction]
            );

            this._executePlan(
                plan,
                `swap-full-${sourceSide}-to-${direction}`
            );

            return;
        }

        this._pushMove(
            plan,
            win,
            halves[direction]
        );

        this._executePlan(
            plan,
            `move-full-to-${direction}`
        );
    }

    // =========================================================
    // Vertical stack swap
    // =========================================================

    _tryVerticalStackSwap(
        win,
        horizontal,
        verticalKey
    ) {
        const area =
            this._screenArea(
                win
            );

        const currentRect =
            this._effectiveRect(
                win
            );

        const currentSide =
            this._dominantSide(
                currentRect,
                area
            );

        if (
            currentSide !== horizontal
            ||
            this._isFullHeight(
                currentRect,
                area
            )
        ) {
            return false;
        }

        const currentVertical =
            this._verticalSlot(
                currentRect,
                area
            );

        const wantedVertical =
            verticalKey === 'up'
                ? 'top'
                : 'bottom';

        if (
            currentVertical
            === wantedVertical
        ) {
            return false;
        }

        const peers =
            this._entriesOnSide(
                this._candidateEntries(
                    win,
                    area
                ),
                horizontal
            );

        const sibling =
            peers.find(
                entry =>
                    !entry.fullHeight
                    &&
                    entry.vertical
                    === wantedVertical
            );

        if (!sibling)
            return false;

        console.log(
            `[Smart Arrow Tiling] SLOT-SWAP ` +
            `${currentVertical}->${wantedVertical} ` +
            `on ${horizontal}`
        );

        this._executePlan(
            [
                {
                    win,
                    rect: {
                        ...sibling.rect,
                    },
                },
                {
                    win:
                        sibling.win,

                    rect: {
                        ...currentRect,
                    },
                },
            ],
            `vertical-slot-swap-${horizontal}`
        );

        return true;
    }

    // =========================================================
    // Smart 1/3
    // =========================================================

    _tileThirdSmart(
        win,
        direction
    ) {
        const area =
            this._screenArea(
                win
            );

        const pair =
            this._thirdPair(
                area,
                direction
            );

        /*
         * ALL other tiled windows participate.
         * With two peers they stay stacked in the complementary 2/3.
         */
        const peers =
            this._candidateEntries(
                win,
                area
            );

        /*
         * A 1/3 + 2/3 layout supports at most three tiled windows total.
         * With four windows, collapsing only the focused window would
         * overlap or uncover another slot, so preserve the gapless grid.
         */
        if (peers.length > 2)
            return;

        const plan = [];

        this._pushMove(
            plan,
            win,
            pair.current
        );

        if (
            peers.length >= 1
            &&
            peers.length <= 2
        ) {
            this._fitWindowsIntoRegion(
                plan,
                peers,
                pair.complement
            );
        }

        this._executePlan(
            plan,
            `${direction}-one-third-smart`
        );
    }

    // =========================================================
    // Quarter
    // =========================================================

    _tileQuarter(
        win,
        horizontal,
        verticalKey
    ) {
        const area =
            this._screenArea(win);

        const rect =
            this._effectiveRect(win);

        const vertical =
            verticalKey === 'up'
                ? 'top'
                : 'bottom';

        if (
            !this._isLikelyTiled(
                rect,
                area
            )
        ) {
            this._executePlan(
                [
                    {
                        win,
                        rect:
                            this._quarter(
                                area,
                                horizontal,
                                vertical
                            ),
                    },
                ],
                `${horizontal}-${vertical}`
            );

            return;
        }

        if (
            this._isFullHeight(
                rect,
                area
            )
        ) {
            /* A lone full column stays full instead of creating an empty half. */
            return;
        }

        const side =
            this._dominantSide(
                rect,
                area
            );

        if (side !== horizontal) {
            this._movePartialAcrossSides(
                win,
                horizontal,
                vertical,
                rect,
                'quarter-cross'
            );

            return;
        }

        const currentVertical =
            this._verticalSlot(
                rect,
                area
            );

        if (currentVertical === vertical)
            return;

        this._tryVerticalStackSwap(
            win,
            horizontal,
            verticalKey
        );
    }

    // =========================================================
    // Manual resize auto-complement
    // =========================================================

    _onGrabBegin(win) {
        if (
            !this._isSupportedWindow(win)
            ||
            !this._grabStarts
        ) {
            return;
        }

        /*
         * A manual resize must win immediately over an old keyboard snap.
         * Otherwise the convergence timer can keep pulling the window back
         * while the user is dragging its divider.
         */
        this._cancelJob(win);
        this._cancelManualReflowTimer(win);
        this._resetActorAnimation(win);

        try {
            const rect = {
                ...win.get_frame_rect(),
            };

            this._grabStarts.set(
                win.get_id(),
                rect
            );

            this._grabLastRects?.set(
                win.get_id(),
                {
                    ...rect,
                }
            );

            this._connectGrabLiveSignals(win);

        } catch (_) {
        }
    }

    _onGrabEnd(win) {
        if (
            !this._isSupportedWindow(win)
            ||
            !this._grabStarts
        ) {
            return;
        }

        const id =
            win.get_id();

        this._disconnectGrabLiveSignals(win);

        const before =
            this._grabStarts.get(id);

        const last =
            this._grabLastRects?.get(id)
            ?? before;

        this._grabStarts.delete(id);
        this._grabLastRects?.delete(id);

        if (!before)
            return;

        let after;

        try {
            after = {
                ...win.get_frame_rect(),
            };
        } catch (_) {
            return;
        }

        const widthChangedFromStart =
            Math.abs(
                after.width
                - before.width
            );

        const heightChangedFromStart =
            Math.abs(
                after.height
                - before.height
            );

        const widthChangedFromLast =
            Math.abs(
                after.width
                - last.width
            );

        const heightChangedFromLast =
            Math.abs(
                after.height
                - last.height
            );

        /*
         * Pure move with no resize at any point: nothing to repair. If the
         * user resized and then returned to the original size, the live pass
         * already restored peers; a pending final delta is still handled.
         */
        if (
            widthChangedFromStart
            < RESIZE_CHANGE_TOLERANCE
            &&
            heightChangedFromStart
            < RESIZE_CHANGE_TOLERANCE
            &&
            widthChangedFromLast
            < RESIZE_CHANGE_TOLERANCE
            &&
            heightChangedFromLast
            < RESIZE_CHANGE_TOLERANCE
        ) {
            return;
        }

        this._cancelManualReflowTimer(
            win
        );

        const sourceId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                MANUAL_REFLOW_DELAY_MS,
                () => {
                    this._manualReflowTimers
                        ?.delete(id);

                    let settled;

                    try {
                        settled = {
                            ...win.get_frame_rect(),
                        };

                    } catch (_) {
                        return GLib.SOURCE_REMOVE;
                    }

                    this._autoComplementAfterManualResize(
                        win,
                        last,
                        settled
                    );

                    return GLib.SOURCE_REMOVE;
                }
            );

        this._manualReflowTimers.set(
            id,
            sourceId
        );
    }

    _autoComplementAfterManualResize(
        win,
        before,
        after
    ) {
        const area =
            this._screenArea(
                win
            );

        if (
            !this._isLikelyTiled(
                after,
                area
            )
        ) {
            return;
        }

        const widthChanged =
            Math.abs(
                after.width
                - before.width
            );

        const heightChanged =
            Math.abs(
                after.height
                - before.height
            );

        const horizontalChanged =
            widthChanged
            >= RESIZE_CHANGE_TOLERANCE;

        const verticalChanged =
            heightChanged
            >= RESIZE_CHANGE_TOLERANCE;

        /*
         * Treat width and height independently. A corner resize can change
         * both dividers, so both complementary reflows are allowed to run.
         *
         * Horizontal reflow:
         * - same-column windows inherit the dragged x/width
         * - the opposite column consumes the remaining screen width
         *
         * Vertical reflow:
         * - only the sibling in this column follows the top/bottom divider
         * - the other column keeps its own top/bottom split
         */
        if (horizontalChanged) {
            this._autoComplementHorizontalResize(
                win,
                area,
                after
            );
        }

        if (verticalChanged) {
            this._autoComplementVerticalResize(
                win,
                area,
                after
            );
        }
    }

    _autoComplementHorizontalResize(
        win,
        area,
        currentRect
    ) {
        const bounds =
            this._innerBounds(
                area
            );

        const side =
            this._edgeSide(
                currentRect,
                area
            );

        const opposite =
            this._opposite(
                side
            );

        const peers =
            this._candidateEntries(
                win,
                area
            );

        const sameSide =
            this._entriesOnSide(
                peers,
                side
            );

        const oppositeSide =
            this._entriesOnSide(
                peers,
                opposite
            );

        const plan = [];

        let currentRegion;
        let oppositeRegion;

        if (
            side === 'left'
        ) {
            const boundary =
                Math.max(
                    bounds.left
                    + MIN_REGION_SIZE,

                    Math.min(
                        bounds.right
                        - INNER_GAP
                        - MIN_REGION_SIZE,

                        currentRect.x
                        + currentRect.width
                    )
                );

            currentRegion = {
                x:
                    bounds.left,

                y:
                    bounds.top,

                width:
                    boundary
                    - bounds.left,

                height:
                    bounds.bottom
                    - bounds.top,
            };

            oppositeRegion = {
                x:
                    boundary
                    + INNER_GAP,

                y:
                    bounds.top,

                width:
                    bounds.right
                    - boundary
                    - INNER_GAP,

                height:
                    bounds.bottom
                    - bounds.top,
            };

        } else {
            const boundary =
                Math.max(
                    bounds.left
                    + MIN_REGION_SIZE
                    + INNER_GAP,

                    Math.min(
                        bounds.right
                        - MIN_REGION_SIZE,

                        currentRect.x
                    )
                );

            oppositeRegion = {
                x:
                    bounds.left,

                y:
                    bounds.top,

                width:
                    boundary
                    - INNER_GAP
                    - bounds.left,

                height:
                    bounds.bottom
                    - bounds.top,
            };

            currentRegion = {
                x:
                    boundary,

                y:
                    bounds.top,

                width:
                    bounds.right
                    - boundary,

                height:
                    bounds.bottom
                    - bounds.top,
            };
        }

        /*
         * Other windows in the SAME column inherit the new x/width,
         * while their own vertical size stays unchanged.
         */
        for (
            const entry
            of sameSide
        ) {
            this._pushMove(
                plan,
                entry.win,
                {
                    x:
                        currentRegion.x,

                    y:
                        entry.rect.y,

                    width:
                        currentRegion.width,

                    height:
                        entry.rect.height,
                }
            );
        }

        /*
         * Opposite side:
         * one full window or two stacked windows fill the remaining width.
         */
        if (
            oppositeSide.length >= 1
            &&
            oppositeSide.length <= 2
        ) {
            this._fitWindowsIntoRegion(
                plan,
                oppositeSide,
                oppositeRegion
            );
        }

        this._executePlan(
            plan,
            `manual-horizontal-reflow-${side}`,
            false
        );
    }

    _autoComplementVerticalResize(
        win,
        area,
        currentRect
    ) {
        if (
            this._isFullHeight(
                currentRect,
                area
            )
        ) {
            return;
        }

        const side =
            this._dominantSide(
                currentRect,
                area
            );

        const vertical =
            this._verticalSlot(
                currentRect,
                area
            );

        const peers =
            this._entriesOnSide(
                this._candidateEntries(
                    win,
                    area
                ),
                side
            );

        const sibling =
            peers.find(
                entry =>
                    !entry.fullHeight
                    &&
                    entry.vertical
                    !== vertical
            );

        if (!sibling)
            return;

        const bounds =
            this._innerBounds(
                area
            );

        const plan = [];

        /*
         * Keep the resized window where the user left it.
         * Adjust only the sibling to consume the remaining height.
         */
        if (
            vertical === 'top'
        ) {
            const siblingY =
                currentRect.y
                + currentRect.height
                + INNER_GAP;

            const siblingHeight =
                bounds.bottom
                - siblingY;

            if (
                siblingHeight
                < MIN_REGION_SIZE
            ) {
                return;
            }

            this._pushMove(
                plan,
                sibling.win,
                {
                    x:
                        currentRect.x,

                    y:
                        siblingY,

                    width:
                        currentRect.width,

                    height:
                        siblingHeight,
                }
            );

        } else {
            const siblingHeight =
                currentRect.y
                - INNER_GAP
                - bounds.top;

            if (
                siblingHeight
                < MIN_REGION_SIZE
            ) {
                return;
            }

            this._pushMove(
                plan,
                sibling.win,
                {
                    x:
                        currentRect.x,

                    y:
                        bounds.top,

                    width:
                        currentRect.width,

                    height:
                        siblingHeight,
                }
            );
        }

        this._executePlan(
            plan,
            `manual-vertical-reflow-${side}`,
            false
        );
    }

    _connectGrabLiveSignals(win) {
        if (
            !win
            ||
            !this._grabLiveSignals
        ) {
            return;
        }

        this._disconnectGrabLiveSignals(win);

        const ids = [];

        const schedule = () => {
            this._scheduleLiveManualReflow(win);
        };

        for (
            const signal
            of [
                'size-changed',
                'position-changed',
            ]
        ) {
            try {
                ids.push(
                    win.connect(
                        signal,
                        schedule
                    )
                );
            } catch (_) {
            }
        }

        if (ids.length) {
            this._grabLiveSignals.set(
                win.get_id(),
                {
                    win,
                    ids,
                }
            );
        }
    }

    _disconnectGrabLiveSignals(win) {
        if (
            !win
            ||
            !this._grabLiveSignals
        ) {
            return;
        }

        const id =
            win.get_id();

        const record =
            this._grabLiveSignals.get(id);

        if (!record)
            return;

        for (
            const signalId
            of record.ids
        ) {
            try {
                record.win.disconnect(
                    signalId
                );
            } catch (_) {
            }
        }

        this._grabLiveSignals.delete(id);
    }

    _disconnectAllGrabLiveSignals() {
        if (!this._grabLiveSignals)
            return;

        for (
            const record
            of this._grabLiveSignals.values()
        ) {
            for (
                const signalId
                of record.ids
            ) {
                try {
                    record.win.disconnect(
                        signalId
                    );
                } catch (_) {
                }
            }
        }

        this._grabLiveSignals.clear();
    }

    _scheduleLiveManualReflow(win) {
        if (
            !win
            ||
            !this._manualReflowTimers
            ||
            !this._grabStarts
            ||
            !this._grabLastRects
        ) {
            return;
        }

        const id =
            win.get_id();

        if (
            this._manualReflowTimers.has(id)
        ) {
            return;
        }

        const sourceId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                LIVE_REFLOW_INTERVAL_MS,
                () => {
                    this._manualReflowTimers
                        ?.delete(id);

                    const before =
                        this._grabLastRects
                            ?.get(id);

                    if (!before)
                        return GLib.SOURCE_REMOVE;

                    let current;

                    try {
                        current = {
                            ...win.get_frame_rect(),
                        };
                    } catch (_) {
                        return GLib.SOURCE_REMOVE;
                    }

                    this._autoComplementAfterManualResize(
                        win,
                        before,
                        current
                    );

                    this._grabLastRects
                        ?.set(
                            id,
                            {
                                ...current,
                            }
                        );

                    return GLib.SOURCE_REMOVE;
                }
            );

        this._manualReflowTimers.set(
            id,
            sourceId
        );
    }

    _cancelManualReflowTimer(
        win
    ) {
        if (
            !win
            ||
            !this._manualReflowTimers
        ) {
            return;
        }

        const id =
            win.get_id();

        const sourceId =
            this._manualReflowTimers
                .get(id);

        if (
            sourceId !== undefined
        ) {
            try {
                GLib.Source.remove(
                    sourceId
                );

            } catch (_) {
            }

            this._manualReflowTimers
                .delete(id);
        }
    }

    _stopAllManualReflowTimers() {
        if (
            !this._manualReflowTimers
        ) {
            return;
        }

        for (
            const sourceId
            of this._manualReflowTimers
                .values()
        ) {
            try {
                GLib.Source.remove(
                    sourceId
                );

            } catch (_) {
            }
        }

        this._manualReflowTimers.clear();
        this._grabStarts?.clear();
        this._grabLastRects?.clear();
    }

    // =========================================================
    // Maximize state
    // =========================================================

    _maximizeFlags(win) {
        try {
            if (
                typeof win.get_maximize_flags
                === 'function'
            ) {
                return Number(
                    win.get_maximize_flags()
                );
            }

        } catch (_) {
        }

        try {
            return (
                win.is_maximized()
                    ? Number(
                        Meta.MaximizeFlags.BOTH
                    )
                    : 0
            );

        } catch (_) {
            return 0;
        }
    }

    _hasMaximizeState(win) {
        return (
            this._maximizeFlags(win)
            !== 0
        );
    }

    _fullUnmaximize(win) {
        try {
            if (
                typeof win.set_unmaximize_flags
                === 'function'
            ) {
                win.set_unmaximize_flags(
                    Meta.MaximizeFlags.BOTH
                );
            }

            win.unmaximize();

        } catch (error) {
            console.error(
                `[Smart Arrow Tiling] ` +
                `unmaximize failed: ${error}`
            );
        }
    }

    // =========================================================
    // Geometry engine
    // =========================================================

    _matches(
        actual,
        target
    ) {
        return (
            Math.abs(
                actual.x
                - target.x
            ) <= GEOMETRY_TOLERANCE

            &&

            Math.abs(
                actual.y
                - target.y
            ) <= GEOMETRY_TOLERANCE

            &&

            Math.abs(
                actual.width
                - target.width
            ) <= GEOMETRY_TOLERANCE

            &&

            Math.abs(
                actual.height
                - target.height
            ) <= GEOMETRY_TOLERANCE
        );
    }

    _applyGeometry(
        win,
        rect
    ) {
        if (
            !win
            ||
            win.is_fullscreen()
        ) {
            return false;
        }

        try {
            win.move_resize_frame(
                true,

                Math.round(
                    rect.x
                ),

                Math.round(
                    rect.y
                ),

                Math.round(
                    rect.width
                ),

                Math.round(
                    rect.height
                )
            );

            return true;

        } catch (error) {
            console.error(
                `[Smart Arrow Tiling] ` +
                `move_resize_frame failed: ${error}`
            );

            return false;
        }
    }

    _requestGeometry(
        win,
        rect,
        fromRect = null,
        animate = true
    ) {
        if (
            !win
            ||
            win.is_fullscreen()
        ) {
            return;
        }

        const id =
            win.get_id();

        const wasMaximized =
            this._hasMaximizeState(
                win
            );

        const target = {
            x:
                Math.round(
                    rect.x
                ),

            y:
                Math.round(
                    rect.y
                ),

            width:
                Math.round(
                    rect.width
                ),

            height:
                Math.round(
                    rect.height
                ),
        };

        this._pending.set(
            id,
            {
                win,

                rect:
                    target,

                fromRect:
                    fromRect
                    ??
                    win.get_frame_rect(),

                animate:
                    animate
                    && !wasMaximized,
            }
        );

        this._cancelTimer(
            win
        );

        this._resetActorAnimation(
            win
        );

        if (
            wasMaximized
        ) {
            this._fullUnmaximize(
                win
            );
        }

        this._applyGeometry(
            win,
            target
        );

        let attempts = 0;

        const timerId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                CONVERGE_INTERVAL_MS,
                () => {
                    attempts++;

                    const pending =
                        this._pending
                            ?.get(id);

                    if (!pending) {
                        this._timers
                            ?.delete(id);

                        return GLib.SOURCE_REMOVE;
                    }

                    if (
                        this._hasMaximizeState(
                            pending.win
                        )
                    ) {
                        this._fullUnmaximize(
                            pending.win
                        );
                    }

                    this._applyGeometry(
                        pending.win,
                        pending.rect
                    );

                    let actual;

                    try {
                        actual =
                            pending.win
                                .get_frame_rect();

                    } catch (_) {
                        this._pending
                            ?.delete(id);

                        this._timers
                            ?.delete(id);

                        return GLib.SOURCE_REMOVE;
                    }

                    if (
                        !this._hasMaximizeState(
                            pending.win
                        )
                        &&
                        this._matches(
                            actual,
                            pending.rect
                        )
                    ) {
                        this._pending
                            ?.delete(id);

                        this._timers
                            ?.delete(id);

                        if (
                            pending.animate
                        ) {
                            this._animateArrival(
                                pending.win,
                                pending.fromRect,
                                actual
                            );
                        }

                        return GLib.SOURCE_REMOVE;
                    }

                    if (
                        attempts
                        >= CONVERGE_MAX_ATTEMPTS
                    ) {
                        console.error(
                            `[Smart Arrow Tiling] ` +
                            `convergence failed ` +
                            `target=${pending.rect.x},${pending.rect.y} ` +
                            `${pending.rect.width}x${pending.rect.height} ` +
                            `actual=${actual.x},${actual.y} ` +
                            `${actual.width}x${actual.height} ` +
                            `flags=${this._maximizeFlags(pending.win)}`
                        );

                        this._pending
                            ?.delete(id);

                        this._timers
                            ?.delete(id);

                        return GLib.SOURCE_REMOVE;
                    }

                    return GLib.SOURCE_CONTINUE;
                }
            );

        this._timers.set(
            id,
            timerId
        );
    }

    // =========================================================
    // Animation
    // =========================================================

    _animateArrival(
        win,
        from,
        to
    ) {
        if (
            !ANIMATIONS_ENABLED
            ||
            !win
            ||
            !from
            ||
            !to
        ) {
            return;
        }

        const dx =
            from.x
            - to.x;

        const dy =
            from.y
            - to.y;

        const scaleX =
            from.width
            /
            Math.max(
                1,
                to.width
            );

        const scaleY =
            from.height
            /
            Math.max(
                1,
                to.height
            );

        if (
            Math.abs(dx) < 3
            &&
            Math.abs(dy) < 3
            &&
            Math.abs(
                scaleX - 1
            ) < 0.01
            &&
            Math.abs(
                scaleY - 1
            ) < 0.01
        ) {
            return;
        }

        let actor;

        try {
            actor =
                win.get_compositor_private();

        } catch (_) {
            return;
        }

        if (!actor)
            return;

        try {
            actor.remove_all_transitions();

            actor.set_pivot_point(
                0,
                0
            );

            actor.translation_x =
                dx;

            actor.translation_y =
                dy;

            actor.scale_x =
                Math.max(
                    0.70,
                    Math.min(
                        1.42,
                        scaleX
                    )
                );

            actor.scale_y =
                Math.max(
                    0.70,
                    Math.min(
                        1.42,
                        scaleY
                    )
                );

            this._animatedActors
                ?.add(actor);

            actor.ease({
                translation_x:
                    0,

                translation_y:
                    0,

                scale_x:
                    1,

                scale_y:
                    1,

                duration:
                    ANIMATION_MS,

                mode:
                    Clutter.AnimationMode
                        .EASE_OUT_QUAD,

                onComplete: () => {
                    try {
                        actor.translation_x = 0;
                        actor.translation_y = 0;
                        actor.scale_x = 1;
                        actor.scale_y = 1;

                    } catch (_) {
                    }

                    this._animatedActors
                        ?.delete(actor);
                },
            });

        } catch (error) {
            console.error(
                `[Smart Arrow Tiling] ` +
                `animation failed: ${error}`
            );

            this._animatedActors
                ?.delete(actor);
        }
    }

    _resetActorAnimation(win) {
        if (!win)
            return;

        let actor;

        try {
            actor =
                win.get_compositor_private();

        } catch (_) {
            return;
        }

        if (!actor)
            return;

        try {
            actor.remove_all_transitions();
            actor.translation_x = 0;
            actor.translation_y = 0;
            actor.scale_x = 1;
            actor.scale_y = 1;

        } catch (_) {
        }

        this._animatedActors
            ?.delete(actor);
    }

    _resetAllActorAnimations() {
        if (!this._animatedActors)
            return;

        for (
            const actor
            of this._animatedActors
        ) {
            try {
                actor.remove_all_transitions();
                actor.translation_x = 0;
                actor.translation_y = 0;
                actor.scale_x = 1;
                actor.scale_y = 1;

            } catch (_) {
            }
        }

        this._animatedActors.clear();
    }

    // =========================================================
    // Cleanup
    // =========================================================

    _cancelTimer(win) {
        if (
            !win
            ||
            !this._timers
        ) {
            return;
        }

        const id =
            win.get_id();

        const timerId =
            this._timers.get(id);

        if (
            timerId !== undefined
        ) {
            try {
                GLib.Source.remove(
                    timerId
                );

            } catch (_) {
            }

            this._timers.delete(id);
        }
    }

    _cancelJob(win) {
        if (!win)
            return;

        this._cancelTimer(
            win
        );

        this._pending
            ?.delete(
                win.get_id()
            );
    }

    _stopAll() {
        this._clearDelayedHorizontal(
            false
        );

        if (
            this._timers
        ) {
            for (
                const timerId
                of this._timers.values()
            ) {
                try {
                    GLib.Source.remove(
                        timerId
                    );

                } catch (_) {
                }
            }

            this._timers.clear();
        }

        this._pending
            ?.clear();
    }
}