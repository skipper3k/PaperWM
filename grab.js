
var Extension;
if (imports.misc.extensionUtils.extensions) {
    Extension = imports.misc.extensionUtils.extensions["paperwm@hedning:matrix.org"];
} else {
    Extension = imports.ui.main.extensionManager.lookup("paperwm@hedning:matrix.org");
}

var Meta = imports.gi.Meta;
var Clutter = imports.gi.Clutter;
var St = imports.gi.St;
var Main = imports.ui.main;

var Tiling = Extension.imports.tiling;
var Scratch = Extension.imports.scratch;
var prefs = Extension.imports.settings.prefs;
var Utils = Extension.imports.utils;
var Tweener = Utils.tweener;
var Navigator = Extension.imports.navigator;


function isInRect(x, y, r) {
    return r.x <= x && x < r.x + r.width &&
        r.y <= y && y < r.y + r.height;
}


function monitorAtPoint(gx, gy) {
    for (let monitor of Main.layoutManager.monitors) {
        if (isInRect(gx, gy, monitor))
            return monitor;
    }
    return null;
}

function createDndZonesForMonitors() {
    let monitorToZones = new Map();
    for (let [monitor, space] of Tiling.spaces.monitors) {
        monitorToZones.set(monitor, createDnDZones(space));
    }
    return monitorToZones;
}

function createDnDZones(space) {

    // In pixels protuding into the window. Ie. exclusive window_gap
    let columnZoneMargin = 100;
    let tileZoneMargin = 250;

    function mkZoneActor(zone, color="red") {
        let actor = new St.Widget({style_class: "tile-preview"})
        actor.visible = false;
        actor.x = zone.rect.x;
        actor.y = zone.rect.y;
        actor.width = zone.rect.width;
        actor.height = zone.rect.height;

        space.cloneContainer.add_actor(actor);
        actor.raise_top();
        return actor
    }

    function mkColumnZone(x, position) {
        // Represent zones as center, margin instead of "regular" rects?
        let margin = prefs.window_gap / 2 + columnZoneMargin

        let detection = {
            x: x - prefs.window_gap - columnZoneMargin,
            y: 0,
            width: margin * 2,
            height: space.height
        };

        let zone = {
            // Detection:
            rect: detection,
            position: position,

            space: space,

            // Visualization:
            center: detection.x + detection.width / 2,
            marginA: margin,  // left
            marginB: margin,  // right

            // Animation props:
            originProp: "x",
            sizeProp: "width",
        };
        zone.actor = mkZoneActor(zone, "red");
        zone.actor.y = Tiling.panelBox.height;
        zone.actor.height = space.height - Tiling.panelBox.height;
        return zone;
    }

    function mkTileZone(x, y, width, position) {
        let detection = {
            x: x + columnZoneMargin,
            y: y - prefs.window_gap - tileZoneMargin,
            width: width - columnZoneMargin * 2,
            height: prefs.window_gap + tileZoneMargin * 2,
        };

        let margin = prefs.window_gap + tileZoneMargin;
        let cy = detection.y + detection.height / 2;
        let marginTop = Math.min(cy - Tiling.panelBox.height, margin);
        let marginBottom = margin;

        let zone = {
            rect: detection,
            position: position,

            space: space,

            // Visualization:
            center: cy,
            marginA: marginTop,
            marginB: marginBottom,

            // Animation props:
            originProp: "y",
            sizeProp: "height",
        };
        zone.actor = mkZoneActor(zone, "blue");
        zone.actor.x = x - prefs.window_gap / 2;
        zone.actor.width = width + prefs.window_gap;
        return zone;
    }

    let zones = [];
    for (let i = 0; i < space.length; i++) {
        let col = space[i];
        zones.push(mkColumnZone(col[0].clone.targetX, [i]));

        for (let j = 0; j < col.length; j++) {
            let metaWindow = col[j];
            let x = metaWindow.clone.targetX;
            let y = metaWindow.clone.targetY;
            let width = metaWindow._targetWidth || metaWindow.clone.width;
            zones.push(mkTileZone(x, y, width, [i, j]));
        }

        let lastRow = col[col.length-1];
        let x = lastRow.clone.targetX;
        let y = lastRow.clone.targetY;
        let width = lastRow._targetWidth || lastRow.clone.width;
        let height = lastRow._targetHeight || lastRow.clone.height;
        zones.push(mkTileZone(x, y + height + prefs.window_gap, width, [i, col.length]));
    }

    zones.push(mkColumnZone(space.cloneContainer.width + prefs.window_gap, [space.length]));
    if (space.length === 0) {
        space.targetX = Math.round(space.width/2);
        space.cloneContainer.x = space.targetX;
        let width = Math.round(space.width/2);
        let zone = zones[0];
        zone.rect.width = width;
        zone.rect.x = -Math.round(width/2);
        zone.rect.center = 0;
    }

    return zones;
}


var MoveGrab = class MoveGrab {
    constructor(metaWindow, type) {
        this.window = metaWindow;
        this.type = type;
        this.signals = new Utils.Signals();

        this.initialSpace = Tiling.spaces.spaceOfWindow(metaWindow);
    }

    begin() {
        let metaWindow = this.window;
        let frame = metaWindow.get_frame_rect();
        let space = Tiling.spaces.spaceOfWindow(metaWindow);

        this.initialY = frame.y;

        let actor = metaWindow.get_compositor_private();
        let [gx, gy, $] = global.get_pointer();
        let px = (gx - actor.x) / actor.width;
        let py = (gy - actor.y) / actor.height;
        actor.set_pivot_point(px, py);

        let clone = metaWindow.clone;
        let [x, y] = space.globalToScroll(gx, gy);
        px = (x - clone.x) / clone.width;
        py = (y - clone.y) / clone.height;
        clone.set_pivot_point(px, py);

        this.signals.connect(
            global.screen || global.display, "window-entered-monitor",
            this.beginDnD.bind(this)
        );

        this.scrollAnchor = metaWindow.clone.targetX + space.monitor.x;
        this.signals.connect(
            metaWindow, 'position-changed', this.positionChanged.bind(this)
        );
        space.startAnimate();
        // Make sure the window actor is visible
        Tiling.showWindow(metaWindow);
        Tweener.removeTweens(space.cloneContainer);
    }

    beginDnD() {
        if (this.dnd)
            return;
        this.dnd = true;
        global.display.end_grab_op(global.get_current_time());
        global.display.set_cursor(Meta.Cursor.MOVE_OR_RESIZE_WINDOW);

        let metaWindow = this.window;
        let frame = metaWindow.get_frame_rect();
        let actor = metaWindow.get_compositor_private();
        let clone = metaWindow.clone;
        let space = this.initialSpace;

        let i = space.indexOf(metaWindow);
        let single = i !== -1 && space[i].length === 1;
        space.removeWindow(metaWindow);

        clone.reparent(Main.uiGroup);
        clone.x = frame.x;
        clone.y = frame.y;
        Tiling.animateWindow(metaWindow);

        Tweener.addTween(clone, {time: prefs.animation_time, scale_x: 0.5, scale_y: 0.5});

        let [gx, gy, $] = global.get_pointer();

        this.pointerOffset = [gx - frame.x, gy - frame.y]
        this.signals.connect(global.stage, "motion-event", this.motion.bind(this));
        this.spaceToDndZones = new Map();
        for (let [workspace, space] of Tiling.spaces) {
            this.signals.connect(space.background, "motion-event", this.spaceMotion.bind(this, space));
            this.spaceToDndZones.set(space, createDnDZones(space));
        }
        this.signals.connect(global.stage, "button-release-event", this.end.bind(this));
        this.signals.connect(global.stage, "button-press-event", this.end.bind(this));
        this.signals.connect(global.stage, "scroll-event", this.scroll.bind(this));

        this.monitorToZones = createDndZonesForMonitors();

        let monitor = monitorAtPoint(gx, gy);
        let onSame = space === Tiling.spaces.monitors.get(monitor);

        let x = gx - space.monitor.x;
        if (onSame && single && space[i]) {
            Tiling.move_to(space, space[i][0], { x: x + prefs.window_gap/2 });
        } else if (onSame && single && space[i-1]) {
            Tiling.move_to(space, space[i-1][0], {
                x: x - space[i-1][0].clone.width - prefs.window_gap/2 });
        } else if (onSame && space.length === 0) {
            space.targetX = x;
            space.cloneContainer.x = x;
        }

        let [sx, sy] = space.globalToScroll(gx, gy, true);
        this.selectDndZone(space, sx, sy, single && onSame);
    }

    spaceMotion(space, background, event) {
        let [bx, by] = event.get_coords();
        this.selectDndZone(space, bx - space.targetX, by);
    }

    /** x,y in scroll cooridinates */
    selectDndZone(space, x, y, initial=false) {
        let dndZones = this.spaceToDndZones.get(space);

        let newDndTarget = null;
        for (let zone of dndZones) {
            if (isInRect(x, y, zone.rect)) {
                if (newDndTarget) {
                    // Treat ambiguous zones as non-match (this way we don't have to ensure zones are non-overlapping :P)
                    newDndTarget = null;
                    break;
                }
                newDndTarget = zone;
            }
        }

        // TODO: rename dndTarget to selectedZone ?
        if (newDndTarget !== this.dndTarget) {
            this.dndTarget && this.deactivateDndTarget(this.dndTarget);
            if (newDndTarget)
                this.activateDndTarget(newDndTarget, initial);
        }
    }

    positionChanged() {
        let metaWindow = this.window;

        let [gx, gy, $] = global.get_pointer();

        if (this.dnd) {
            print("SHOULD NOT HAPPEND")
            // this.selectDndZone(gx, gy);  // TODO: dead/obsolete?
        } else {  // Move the window and scroll the space
            let space = this.initialSpace;
            let clone = metaWindow.clone;
            let frame = metaWindow.get_frame_rect();
            space.targetX = frame.x - this.scrollAnchor;
            space.cloneContainer.x = space.targetX;

            const threshold = 300;
            const dy = Math.min(threshold, Math.abs(frame.y - this.initialY));
            let s = 1 - Math.pow(dy / 500, 3);
            let actor = metaWindow.get_compositor_private();
            actor.set_scale(s, s);
            clone.set_scale(s, s);
            [clone.x, clone.y] = space.globalToScroll(frame.x, frame.y);

            if (dy >= threshold) {
                this.beginDnD();
            }
        }
    }

    scroll(actor, event) {
        let dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.SMOOTH)
            return;
        // print(dir, Clutter.ScrollDirection.SMOOTH, Clutter.ScrollDirection.UP, Clutter.ScrollDirection.DOWN)
        let dx
        if ([Clutter.ScrollDirection.DOWN, Clutter.ScrollDirection.LEFT].includes(dir)) {
            dx = -1;
        } else {
            dx = 1;
        }
        // let dx = dir === Clutter.ScrollDirection.DOWN ? -1 : 1
        // let [dx, dy] = event.get_scroll_delta()

        let [gx, gy] = event.get_coords();
        if (!gx) {
            print("Noooo");
            return;
        }
        print(dx, gx, gy);
        let monitor = monitorAtPoint(gx, gy);
        let space = Tiling.spaces.monitors.get(monitor);

        if (dx === 1)
            space.switchLeft();
        else
            space.switchRight();

        // let speed = 30
        // space.targetX += dx * speed
        // space.cloneContainer.x += dx * speed
    }

    motion(actor, event) {
        let [gx, gy, $] = global.get_pointer();
        let [dx, dy] = this.pointerOffset;
        let clone = this.window.clone;
        clone.x = gx - dx;
        clone.y = gy - dy;
        // this.selectDndZone(...event.get_coords())
        // this.selectDndZone(gx, gy)
    }

    end() {
        this.signals.destroy();

        let metaWindow = this.window;
        let actor = metaWindow.get_compositor_private();
        let frame = metaWindow.get_frame_rect();
        let clone = metaWindow.clone;
        let [gx, gy, $] = global.get_pointer();

        if (this.dnd) {
            let dndTarget = this.dndTarget;

            for (let [space, zones] of this.spaceToDndZones) {
                zones.forEach(zone => zone.actor.destroy());
            }

            if (dndTarget) {
                let space = dndTarget.space;
                space.selection.show()

                if (Scratch.isScratchWindow(metaWindow))
                    Scratch.unmakeScratch(metaWindow);

                // Remember the global coordinates of the clone
                let [x, y] = clone.get_position();
                space.addWindow(metaWindow, ...dndTarget.position);

                [clone.x, clone.y] = space.globalToScroll(x, y);

                actor.set_scale(1, 1);
                actor.set_pivot_point(0, 0);

                Tiling.animateWindow(metaWindow);
                Tweener.addTween(clone, {
                    time: prefs.animation_time,
                    scale_x: 1,
                    scale_y: 1,
                    onComplete: () => {
                        space.moveDone()
                        clone.set_pivot_point(0, 0)
                    }
                });

                space.targetX = space.cloneContainer.x;
                space.selectedWindow = metaWindow;
                if (dndTarget.position) {
                    space.layout(true, {customAllocators: {[dndTarget.position[0]]: Tiling.allocateEqualHeight}});
                } else {
                    space.layout();
                }
                Tiling.move_to(space, metaWindow, {x: x - space.monitor.x})
                Tiling.ensureViewport(metaWindow, space);

                clone.raise_top()
            } else {
                metaWindow.move_frame(true, clone.x, clone.y);
                Scratch.makeScratch(metaWindow);
                this.initialSpace.moveDone();

                clone.set_scale(1, 1);
                clone.set_pivot_point(0, 0);

                Tweener.addTween(actor, {
                    time: prefs.animation_time,
                    scale_x: 1,
                    scale_y: 1,
                    onComplete: () => {
                        actor.set_pivot_point(0, 0)
                    }
                });
            }
        } else if (this.initialSpace.indexOf(metaWindow) !== -1){
            let space = this.initialSpace;
            space.targetX = space.cloneContainer.x;
            clone.targetX = frame.x - space.monitor.x - space.targetX;
            clone.targetY = frame.y - space.monitor.y;
            clone.set_position(clone.targetX,
                               clone.targetY);

            actor.set_scale(1, 1);
            actor.set_pivot_point(0, 0);

            Tiling.animateWindow(metaWindow);
            Tweener.addTween(clone, {
                time: prefs.animation_time,
                scale_x: 1,
                scale_y: 1,
                onComplete: () => {
                    space.moveDone()
                    clone.set_pivot_point(0, 0)
                }
            });

            Tiling.ensureViewport(metaWindow, space);
        }

        // NOTE: we reset window here so `window-added` will handle the window,
        // and layout will work correctly etc.
        this.window = null;

        this.initialSpace.layout();

        // let monitor = monitorAtPoint(gx, gy);
        // let space = Tiling.spaces.monitors.get(monitor);

        // // Make sure the window is on the correct workspace.
        // // If the window is transient this will take care of its parent too.
        // metaWindow.change_workspace(space.workspace)
        // space.workspace.activate(global.get_current_time());
        Tiling.inGrab = false;
        Navigator.getNavigator().finish();
        global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    activateDndTarget(zone, first) {
        zone.space.selection.hide();
        this.dndTarget = zone;

        let params = {
            time: prefs.animation_time,
            [zone.originProp]: zone.center - zone.marginA,
            [zone.sizeProp]: zone.marginA + zone.marginB,
        };

        if (first) {
            params.height = zone.actor.height
            params.y = zone.actor.y

            let actor = this.window.get_compositor_private();
            let space = zone.space;
            zone.actor.set_position(...space.globalToScroll(...actor.get_transformed_position()))
            zone.actor.set_size(...actor.get_transformed_size())
        } else {
            zone.actor[zone.sizeProp] = 0;
            zone.actor[zone.originProp] = zone.center;
        }

        zone.actor.show();
        zone.actor.raise_top();
        Tweener.addTween(zone.actor, params);
    }

    deactivateDndTarget(zone) {
        zone.space.selection.show();
        if (zone) {
            Tweener.addTween(zone.actor, {
                time: prefs.animation_time,
                [zone.originProp]: zone.center,
                [zone.sizeProp]: 0,
                onComplete: () => zone.actor.hide()
            });
        }

        this.dndTarget = null;
    }
}

var ResizeGrab = class ResizeGrab {
    constructor(metaWindow, type) {
        print("Resize grab begin", metaWindow.title)
        this.window = metaWindow;
        this.signals = new Utils.Signals();

        this.space = Tiling.spaces.spaceOfWindow(metaWindow);
        if (this.space.indexOf(metaWindow) === -1)
            return;

        this.scrollAnchor = metaWindow.clone.targetX + this.space.monitor.x;

        this.signals.connect(metaWindow, 'size-changed', () => {
            metaWindow._targetWidth = null;
            metaWindow._targetHeight = null;
            let frame = metaWindow.get_frame_rect();

            this.space.targetX = frame.x - this.scrollAnchor;
            this.space.cloneContainer.x = this.space.targetX;
            this.space.layout(false);
        })
    }
    end() {
        this.signals.destroy();

        this.window = null;
        this.space.layout();
    }
}
