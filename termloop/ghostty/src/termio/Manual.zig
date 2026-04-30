const std = @import("std");
const termio = @import("../termio.zig");
const renderer = @import("../renderer.zig");
const terminal = @import("../terminal/main.zig");

pub const WriteCallback = *const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void;

pub const Config = struct {
    write_cb: ?WriteCallback = null,
    write_userdata: ?*anyopaque = null,
};

pub const Manual = struct {
    write_cb: ?WriteCallback,
    write_userdata: ?*anyopaque,

    pub fn init(_: std.mem.Allocator, cfg: Config) !Manual {
        return .{
            .write_cb = cfg.write_cb,
            .write_userdata = cfg.write_userdata,
        };
    }

    pub fn deinit(_: *Manual) void {}

    pub fn initTerminal(_: *Manual, _: *terminal.Terminal) void {}

    pub fn threadEnter(
        _: *Manual,
        _: std.mem.Allocator,
        _: *termio.Termio,
        td: *termio.Termio.ThreadData,
    ) !void {
        td.backend = .{ .manual = .{} };
    }

    pub fn threadExit(_: *Manual, _: *termio.Termio.ThreadData) void {}

    pub fn focusGained(_: *Manual, _: *termio.Termio.ThreadData, _: bool) !void {}

    pub fn resize(_: *Manual, _: renderer.GridSize, _: renderer.ScreenSize) !void {}

    pub fn queueWrite(
        self: *Manual,
        alloc: std.mem.Allocator,
        _: *termio.Termio.ThreadData,
        data: []const u8,
        linefeed: bool,
    ) !void {
        const cb = self.write_cb orelse return;
        if (!linefeed) {
            cb(self.write_userdata, data.ptr, data.len);
            return;
        }

        const extra = std.mem.count(u8, data, "\r");
        if (extra == 0) {
            cb(self.write_userdata, data.ptr, data.len);
            return;
        }

        var buf = try alloc.alloc(u8, data.len + extra);
        defer alloc.free(buf);

        var i: usize = 0;
        var o: usize = 0;
        while (i < data.len) : (i += 1) {
            const ch = data[i];
            if (ch == '\r') {
                buf[o] = '\r';
                buf[o + 1] = '\n';
                o += 2;
            } else {
                buf[o] = ch;
                o += 1;
            }
        }

        cb(self.write_userdata, buf.ptr, o);
    }

    pub fn childExitedAbnormally(
        _: *Manual,
        _: std.mem.Allocator,
        _: *terminal.Terminal,
        _: u32,
        _: u64,
    ) !void {}
};

pub const ThreadData = struct {
    pub fn deinit(_: *ThreadData, _: std.mem.Allocator) void {}
};

test "manual queueWrite linefeed conversion" {
    const testing = std.testing;
    var out = std.ArrayList(u8).init(testing.allocator);
    defer out.deinit();

    const cb = struct {
        fn write(ud: ?*anyopaque, ptr: [*]const u8, len: usize) callconv(.c) void {
            const list: *std.ArrayList(u8) = @ptrCast(@alignCast(ud.?));
            _ = list.appendSlice(ptr[0..len]) catch {};
        }
    }.write;

    var manual = try Manual.init(testing.allocator, .{ .write_cb = cb, .write_userdata = &out });
    defer manual.deinit();

    var td: termio.Termio.ThreadData = undefined;
    try manual.queueWrite(testing.allocator, &td, "a\rb", true);
    try testing.expectEqualStrings("a\r\nb", out.items);
}
