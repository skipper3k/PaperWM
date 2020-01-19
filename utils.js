var Extension;
if (imports.misc.extensionUtils.extensions) {
    Extension = imports.misc.extensionUtils.extensions["paperwm@hedning:matrix.org"];
} else {
    Extension = imports.ui.main.extensionManager.lookup("paperwm@hedning:matrix.org");
}
const Gdk = imports.gi.Gdk;
var GLib = imports.gi.GLib;
var Meta = imports.gi.Meta;

var workspaceManager = global.workspace_manager;
var display = global.display;

var GObject = imports.gi.GObject;
var registerClass;

var version = imports.misc.config.PACKAGE_VERSION.split('.').map(Number);
{
    if (version[0] >= 3 && version[1] > 30) {
        registerClass = GObject.registerClass;
    } else {
        registerClass = (x, y) => y ? y : x;
    }
}

var debug_all = false; // Turn off by default
var debug_filter = {'#paperwm': true, '#stacktrace': true};
function debug() {
    let keyword = arguments[0];
    let filter = debug_filter[keyword];
    if (filter === false)
        return;
    if (debug_all || filter === true)
        print(Array.prototype.join.call(arguments, " | "));
}

function warn(...args) {
    print("WARNING:", ...args);
}

function assert(condition, message, ...dump) {
    if (!condition) {
        throw new Error(message + "\n", dump);
    }
}

function withTimer(message, fn) {
    let start = GLib.get_monotonic_time();
    let ret = fn();
    let stop = GLib.get_monotonic_time();
    log(`${message} ${((stop - start)/1000).toFixed(1)}ms`);
}

function print_stacktrace(error) {
    let trace;
    if (!error) {
        trace = (new Error()).stack.split("\n");
        // Remove _this_ frame
        trace.splice(0, 1);
    } else {
        trace = error.stack.split("\n");
    }
    // Remove some uninteresting frames
    let filtered = trace.filter((frame) => {
        return frame !== "wrapper@resource:///org/gnome/gjs/modules/lang.js:178";
    });
    log(`JS ERROR: ${error}\n ${trace.join('\n')}`);
}

function framestr(rect) {
    return "[ x:"+rect.x + ", y:" + rect.y + " w:" + rect.width + " h:"+rect.height + " ]";
}

/**
 * Returns a human-readable enum value representation
 */
function ppEnumValue(value, genum) {
    let entry = Object.entries(genum).find(([k, v]) => v === value);
    if (entry) {
        return `${entry[0]} (${entry[1]})`
    } else {
        return `<not-found> (${value})`
    }
}

/**
 * Look up the function by name at call time. This makes it convenient to
 * redefine the function without re-registering all signal handler, keybindings,
 * etc. (this is like a function symbol in lisp)
 */
function dynamic_function_ref(handler_name, owner_obj) {
    owner_obj = owner_obj || window;
    return function() {
        owner_obj[handler_name].apply(this, arguments);
    }
}

/**
   Find the first x in `values` that's larger than `cur`.
   Cycle to first value if no larger value is found.
   `values` should be sorted in ascending order.
 */
function findNext(cur, values, slack=0) {
    for (let i = 0; i < values.length; i++) {
        let x = values[i];
        if (cur < x) {
            if (x - cur < slack) {
                // Consider `cur` practically equal to `x`
                continue;
            } else {
                return x;
            }
        }
    }
    return values[0]; // cycle
}

function swap(array, i, j) {
    let temp = array[i];
    array[i] = array[j];
    array[j] = temp;
}

function in_bounds(array, i) {
    return i >= 0 && i < array.length;
}

function isPointInsideActor(actor, x, y) {
    return (actor.x <= x && x <= actor.x+actor.width)
        && (actor.y <= y && y <= actor.y+actor.height);
}

function setBackgroundImage(actor, resource_path) {
    // resource://{resource_path}
    const Clutter = imports.gi.Clutter;
    const GdkPixbuf = imports.gi.GdkPixbuf;
    const Cogl = imports.gi.Cogl;

    let image = new Clutter.Image();

    let pixbuf = GdkPixbuf.Pixbuf.new_from_resource(resource_path)

    image.set_data(pixbuf.get_pixels() ,
                   pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888
                   : Cogl.PixelFormat.RGB_888,
                   pixbuf.get_width() ,
                   pixbuf.get_height() ,
                   pixbuf.get_rowstride());
    actor.set_content(image);
    actor.content_repeat = Clutter.ContentRepeat.BOTH
}


//// Debug and development utils

const Tiling = Extension.imports.tiling;

function setDevGlobals() {
    // Accept the risk of this interfering with existing code for now
    metaWindow = display.focus_window;
    meta_window = display.focus_window;
    workspace = workspaceManager.get_active_workspace();
    actor = metaWindow.get_compositor_private();
    space = Tiling.spaces.spaceOfWindow(metaWindow);
    app = imports.gi.Shell.WindowTracker.get_default().get_window_app(metaWindow);
}

/**
 * Visualize the frame and buffer bounding boxes of a meta window
 */
function toggleWindowBoxes(metaWindow) {
    metaWindow = metaWindow || display.focus_window;

    if(metaWindow._paperDebugBoxes) {
        metaWindow._paperDebugBoxes.forEach(box => {
            box.destroy();
        });
        delete metaWindow._paperDebugBoxes;
        return [];
    }

    let frame = metaWindow.get_frame_rect()
    let inputFrame = metaWindow.get_buffer_rect()
    let actor = metaWindow.get_compositor_private();

    makeFrameBox = function({x, y, width, height}, color) {
        let frameBox = new imports.gi.St.Widget();
        frameBox.set_position(x, y)
        frameBox.set_size(width, height)
        frameBox.set_style("border: 2px" + color + " solid");
        return frameBox;
    }

    let boxes = [];

    boxes.push(makeFrameBox(frame, "red"));
    boxes.push(makeFrameBox(inputFrame, "blue"));

    if(inputFrame.x !== actor.x || inputFrame.y !== actor.y
       || inputFrame.width !== actor.width || inputFrame.height !== actor.height) {
        boxes.push(makeFrameBox(actor, "yellow"));
    }

    boxes.forEach(box => global.stage.add_actor(box));

    metaWindow._paperDebugBoxes = boxes;
    return boxes;
}

var markNewClonesSignalId = null;
function toggleCloneMarks() {
    // NB: doesn't clean up signal on disable

    function markCloneOf(metaWindow) {
        if (metaWindow.clone)
            metaWindow.clone.opacity = 190;
    }
    function unmarkCloneOf(metaWindow) {
        if (metaWindow.clone)
            metaWindow.clone.opacity = 255;
    }

    let windows = display.get_tab_list(Meta.TabList.NORMAL_ALL, null);

    if (markNewClonesSignalId) {
        display.disconnect(markNewClonesSignalId);
        markNewClonesSignalId = null;
        windows.forEach(unmarkCloneOf);
    } else {
        markNewClonesSignalId = display.connect_after(
            "window-created", (_, mw) => markCloneOf(mw))

        windows.forEach(markCloneOf);
    }
}


function sum(array) {
    return array.reduce((a, b) => a + b, 0);
}

function zip(...as) {
    let r = [];
    let minLength = Math.min(...as.map(x => x.length));
    for (let i = 0; i < minLength; i++) {
        r.push(as.map(a => a[i]));
    }
    return r;
}

function warpPointer(x, y) {
    let display = Gdk.Display.get_default();
    let deviceManager = display.get_device_manager();
    let pointer = deviceManager.get_client_pointer();
    pointer.warp(Gdk.Screen.get_default(), x, y)
}

function monitorOfPoint(x, y) {
    // get_monitor_index_for_rect "helpfully" returns the primary monitor index for out of bounds rects..
    const Main = imports.ui.main;
    for (let monitor of Main.layoutManager.monitors) {
        if ((monitor.x <= x && x <= monitor.x+monitor.width) &&
            (monitor.y <= y && y <= monitor.y+monitor.height))
        {
            return monitor;
        }
    }

    return null;
}


class Signals extends Map {
    static get [Symbol.species]() { return Map; }

    _getOrCreateSignals(object) {
        let signals = this.get(object);
        if (!signals) {
            signals = [];
            this.set(object, signals);
        }
        return signals;
    }

    connectOneShot(object, signal, handler) {
        let id = this.connect(object, signal, (...args) => {
            this.disconnect(object, id);
            return handler(...args);
        });
    }

    connect(object, signal, handler) {
        let id = object.connect(signal, handler);
        let signals = this._getOrCreateSignals(object);
        signals.push(id);
        return id;
    }

    disconnect(object, id=null) {
        let ids = this.get(object);
        if (ids) {
            if (id === null) {
                ids.forEach(id => object.disconnect(id));
            } else {
                object.disconnect(id);
                let i = ids.indexOf(id);
                if (i > -1) {
                    ids.splice(i, 1);
                }
            }
            this.delete(object);
        }
    }

    destroy() {
        for (let [object, signals] of this) {
            signals.forEach(id => object.disconnect(id));
            this.delete(object);
        }
    }
}

var tweener = {
    addTween(actor, params) {
        if (params.time) {
            params.duration = params.time*1000;
            delete params.time;
        }
        if (!params.mode)
            params.mode = imports.gi.Clutter.AnimationMode.EASE_IN_OUT_QUAD;
        actor.ease(params);
    },

    removeTweens(actor) {
        actor.remove_all_transitions();
    },

    isTweening(actor) {
        return actor.get_transition('x') || actor.get_transition('y') || actor.get_transition('scale-x') || actor.get_transition('scale-x');
    }
};


function trace(topic, ...args) {
    windowTrace(topic, ...args);
}

let existingWindows = new Set();

function windowTrace(topic, metaWindow, ...rest) {
    if (existingWindows.has(metaWindow)) {
        return;
    }

    if (!topic.match(/.*/)) {
        return;
    }

    log(topic, infoMetaWindow(metaWindow).join("\n"), ...rest.join("\n"));
}

function infoMetaWindow(metaWindow) {
    let id = metaWindow.toString().split(" ")[4];
    let trace = shortTrace(3).join(" < ");
    let info = [
        `(win: ${id}) ${trace}`,
        `Title: ${metaWindow.title}`,
    ];
    if (!metaWindow.window_type === Meta.WindowType.NORMAL) {
        info.push(`Type: ${ppEnumValue(metaWindow.window_type, Meta.WindowType)}`);
    }
    if (!metaWindow.get_compositor_private()) {
        info.push(`- no actor`);
    }
    if (metaWindow.is_on_all_workspaces()) {
        info.push(`- is_on_all_workspaces`);
    }
    if (metaWindow.above) {
        info.push(`- above`);
    }
    if (Extension.imports.scratch.isScratchWindow(metaWindow)) {
        info.push(`- scratch`);
    }
    return info;
}

function shortTrace(skip=0) {
    let trace = new Error().stack.split("\n").map(s => {
        let words = s.split(/[@/]/)
        let cols = s.split(":")
        let ln = parseInt(cols[2])
        if (ln === null)
            ln = "?"

        return [words[0], ln]
    })
    trace = trace.filter(([f, ln]) => f !== "dynamic_function_ref").map(([f, ln]) => f === "" ? "?" : f+":"+ln);
    return trace.slice(skip+1, skip+5);
}


// Meta.remove_verbose_topic(Meta.DebugTopic.FOCUS)
