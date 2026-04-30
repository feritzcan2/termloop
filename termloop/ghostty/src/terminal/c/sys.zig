const std = @import("std");
const lib = @import("../lib.zig");
const CAllocator = lib.alloc.Allocator;
const terminal_sys = @import("../sys.zig");
const Result = @import("result.zig").Result;

/// C: GhosttySysImage
pub const Image = extern struct {
    width: u32,
    height: u32,
    data: ?[*]u8,
    data_len: usize,
};

/// C: GhosttySysDecodePngFn
pub const DecodePngFn = *const fn (
    ?*anyopaque,
    *const CAllocator,
    [*]const u8,
    usize,
    *Image,
) callconv(lib.calling_conv) bool;

/// C: GhosttySysOption
pub const Option = enum(c_int) {
    userdata = 0,
    decode_png = 1,

    pub fn InType(comptime self: Option) type {
        return switch (self) {
            .userdata => ?*const anyopaque,
            .decode_png => ?DecodePngFn,
        };
    }
};

/// Global state for the sys interface so we can call through to the C
/// callbacks from Zig.
const Global = struct {
    userdata: ?*anyopaque = null,
    decode_png: ?DecodePngFn = null,
};

/// Global state for the C sys interface.
var global: Global = .{};

/// Zig-compatible wrapper that calls through to the stored C callback.
/// The C callback allocates the pixel data through the provided allocator,
/// so we can take ownership directly.
fn decodePngWrapper(
    alloc: std.mem.Allocator,
    data: []const u8,
) terminal_sys.DecodeError!terminal_sys.Image {
    const func = global.decode_png orelse return error.InvalidData;

    const c_alloc = CAllocator.fromZig(&alloc);
    var out: Image = undefined;
    if (!func(global.userdata, &c_alloc, data.ptr, data.len, &out)) return error.InvalidData;

    const result_data = out.data orelse return error.InvalidData;

    return .{
        .width = out.width,
        .height = out.height,
        .data = result_data[0..out.data_len],
    };
}

pub fn set(
    option: Option,
    value: ?*const anyopaque,
) callconv(lib.calling_conv) Result {
    if (comptime std.debug.runtime_safety) {
        _ = std.meta.intToEnum(Option, @intFromEnum(option)) catch {
            return .invalid_value;
        };
    }

    return switch (option) {
        inline else => |comptime_option| setTyped(
            comptime_option,
            @ptrCast(@alignCast(value)),
        ),
    };
}

fn setTyped(
    comptime option: Option,
    value: option.InType(),
) Result {
    switch (option) {
        .userdata => global.userdata = @constCast(value),
        .decode_png => {
            global.decode_png = value;
            terminal_sys.decode_png = if (value != null) &decodePngWrapper else null;
        },
    }
    return .success;
}

test "set decode_png with null clears" {
    // Start from a known state.
    global.decode_png = null;
    terminal_sys.decode_png = null;

    try std.testing.expectEqual(Result.success, set(.decode_png, null));
    try std.testing.expect(terminal_sys.decode_png == null);
}

test "set decode_png installs wrapper" {
    const S = struct {
        fn decode(_: ?*anyopaque, _: *const CAllocator, _: [*]const u8, _: usize, out: *Image) callconv(lib.calling_conv) bool {
            out.* = .{ .width = 1, .height = 1, .data = null, .data_len = 0 };
            return true;
        }
    };

    try std.testing.expectEqual(Result.success, set(
        .decode_png,
        @ptrCast(&S.decode),
    ));
    try std.testing.expect(terminal_sys.decode_png != null);

    // Clear it again.
    try std.testing.expectEqual(Result.success, set(.decode_png, null));
    try std.testing.expect(terminal_sys.decode_png == null);
}

test "set userdata" {
    var data: u32 = 42;
    try std.testing.expectEqual(Result.success, set(.userdata, @ptrCast(&data)));
    try std.testing.expect(global.userdata == @as(?*anyopaque, @ptrCast(&data)));

    // Clear it.
    try std.testing.expectEqual(Result.success, set(.userdata, null));
    try std.testing.expect(global.userdata == null);
}
