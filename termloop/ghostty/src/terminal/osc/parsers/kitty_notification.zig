const std = @import("std");

const Parser = @import("../../osc.zig").Parser;
const Command = @import("../../osc.zig").Command;
const encoding = @import("../encoding.zig");

const log = std.log.scoped(.osc_kitty_notification);

const PayloadKind = enum {
    title,
    body,
    ignore,
};

pub fn parse(parser: *Parser, _: ?u8) ?*Command {
    const writer = parser.writer orelse {
        parser.state = .invalid;
        return null;
    };

    // Ensure sentinel termination.
    writer.writeByte(0) catch {
        parser.state = .invalid;
        return null;
    };

    var data = writer.buffered();
    if (data.len == 0) {
        parser.state = .invalid;
        return null;
    }

    // Drop sentinel.
    data = data[0 .. data.len - 1];

    const meta_end = std.mem.indexOfScalar(u8, data, ';') orelse {
        parser.state = .invalid;
        return null;
    };

    const meta = data[0..meta_end];
    const payload = data[meta_end + 1 ..];

    var payload_kind: PayloadKind = .title;
    var done = true;
    var base64 = false;
    var id: ?[]const u8 = null;

    if (meta.len > 0) {
        var it = std.mem.splitScalar(u8, meta, ':');
        while (it.next()) |part| {
            if (part.len == 0) continue;
            const eq = std.mem.indexOfScalar(u8, part, '=') orelse continue;
            if (eq == 0) continue;
            const key = part[0];
            const value = part[eq + 1 ..];
            switch (key) {
                'p' => payload_kind = parsePayloadKind(value),
                'd' => done = parseBool(value, true),
                'e' => base64 = parseBool(value, false),
                'i' => {
                    if (isValidId(value)) id = value;
                },
                else => {},
            }
        }
    }

    if (payload_kind == .ignore) {
        return null;
    }

    var payload_bytes: []u8 = payload;
    if (base64) {
        const decoder = std.base64.standard.Decoder;
        const decoded_len = decoder.calcSizeForSlice(payload_bytes) catch {
            parser.state = .invalid;
            return null;
        };
        if (decoded_len > payload_bytes.len) {
            parser.state = .invalid;
            return null;
        }
        _ = decoder.decode(payload_bytes[0..decoded_len], payload_bytes) catch {
            parser.state = .invalid;
            return null;
        };
        payload_bytes = payload_bytes[0..decoded_len];
    }

    if (!encoding.isSafeUtf8(payload_bytes)) {
        parser.state = .invalid;
        return null;
    }

    const pending = &parser.kitty_notification_pending;

    if (id) |value| {
        if (!pending.active or !std.mem.eql(u8, pending.idSlice(), value)) {
            pending.reset();
            pending.active = true;
            pending.id_len = @min(value.len, pending.id.len);
            @memcpy(pending.id[0..pending.id_len], value[0..pending.id_len]);
        }
    } else {
        pending.reset();
        pending.active = true;
    }

    if (!appendPayload(pending, payload_kind, payload_bytes)) {
        parser.state = .invalid;
        return null;
    }

    if (!done) {
        return null;
    }

    if (pending.title_len == 0 and pending.body_len == 0) {
        pending.reset();
        return null;
    }

    pending.title[pending.title_len] = 0;
    pending.body[pending.body_len] = 0;

    var title: [:0]const u8 = pending.title[0..pending.title_len :0];
    var body: [:0]const u8 = pending.body[0..pending.body_len :0];

    if (pending.title_len == 0 and pending.body_len > 0) {
        title = pending.body[0..pending.body_len :0];
        body = "";
    }

    parser.command = .{
        .show_desktop_notification = .{
            .title = title,
            .body = body,
        },
    };

    // Clear lengths for next notification but keep buffers intact for command slices.
    pending.reset();
    return &parser.command;
}

fn parsePayloadKind(value: []const u8) PayloadKind {
    if (std.mem.eql(u8, value, "title")) return .title;
    if (std.mem.eql(u8, value, "body")) return .body;
    if (std.mem.eql(u8, value, "close")) return .ignore;
    if (std.mem.eql(u8, value, "alive")) return .ignore;
    return .ignore;
}

fn parseBool(value: []const u8, default: bool) bool {
    if (value.len == 0) return default;
    return switch (value[0]) {
        '0' => false,
        '1' => true,
        else => default,
    };
}

fn isValidId(value: []const u8) bool {
    if (value.len == 0) return false;
    for (value) |c| {
        if (std.ascii.isAlphanumeric(c)) continue;
        switch (c) {
            '-', '_', '+', '.', ':' => continue,
            else => return false,
        }
    }
    return true;
}

fn appendPayload(
    pending: *Parser.KittyNotificationPending,
    kind: PayloadKind,
    payload: []const u8,
) bool {
    switch (kind) {
        .title => return appendBuffer(&pending.title, &pending.title_len, payload),
        .body => return appendBuffer(&pending.body, &pending.body_len, payload),
        .ignore => return true,
    }
}

fn appendBuffer(buffer: *[Parser.MAX_BUF]u8, len: *usize, payload: []const u8) bool {
    if (payload.len == 0) return true;
    if (len.* + payload.len >= buffer.len) {
        log.warn("kitty notification payload too large (len={d})", .{payload.len});
        return false;
    }
    @memcpy(buffer[len.* .. len.* + payload.len], payload);
    len.* += payload.len;
    return true;
}

test "OSC 99: kitty notification with title only" {
    const testing = std.testing;

    var p: Parser = .init(null);

    const input = "99;;Hello Kitty";
    for (input) |ch| p.next(ch);

    const cmd = p.end('\x1b').?.*;
    try testing.expect(cmd == .show_desktop_notification);
    try testing.expectEqualStrings("Hello Kitty", cmd.show_desktop_notification.title);
    try testing.expectEqualStrings("", cmd.show_desktop_notification.body);
}

test "OSC 99: kitty notification with title and body chunks" {
    const testing = std.testing;

    var p: Parser = .init(null);

    const title = "99;i=abc:d=0:p=title;Kitty Title";
    for (title) |ch| p.next(ch);
    try testing.expect(p.end('\x1b') == null);

    const body = "99;i=abc:p=body;Kitty Body";
    for (body) |ch| p.next(ch);

    const cmd = p.end('\x1b').?.*;
    try testing.expect(cmd == .show_desktop_notification);
    try testing.expectEqualStrings("Kitty Title", cmd.show_desktop_notification.title);
    try testing.expectEqualStrings("Kitty Body", cmd.show_desktop_notification.body);
}
