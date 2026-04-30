/**
 * @file sys.h
 *
 * System interface - runtime-swappable implementations for external dependencies.
 */

#ifndef GHOSTTY_VT_SYS_H
#define GHOSTTY_VT_SYS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <ghostty/vt/types.h>
#include <ghostty/vt/allocator.h>

/** @defgroup sys System Interface
 *
 * Runtime-swappable function pointers for operations that depend on
 * external implementations (e.g. image decoding).
 *
 * These are process-global settings that must be configured at startup
 * before any terminal functionality that depends on them is used.
 * Setting these enables various optional features of the terminal. For
 * example, setting a PNG decoder enables PNG image support in the Kitty
 * Graphics Protocol.
 *
 * Use ghostty_sys_set() with a `GhosttySysOption` to install or clear
 * an implementation. Passing NULL as the value clears the implementation
 * and disables the corresponding feature.
 *
 * ## Example
 *
 * ### Defining a PNG decode callback
 * @snippet c-vt-kitty-graphics/src/main.c kitty-graphics-decode-png
 *
 * ### Installing the callback and sending a PNG image
 * @snippet c-vt-kitty-graphics/src/main.c kitty-graphics-main
 *
 * @{
 */

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Result of decoding an image.
 *
 * The `data` buffer must be allocated through the allocator provided to
 * the decode callback. The library takes ownership and will free it
 * with the same allocator.
 */
typedef struct {
    /** Image width in pixels. */
    uint32_t width;

    /** Image height in pixels. */
    uint32_t height;

    /** Pointer to the decoded RGBA pixel data. */
    uint8_t* data;

    /** Length of the pixel data in bytes. */
    size_t data_len;
} GhosttySysImage;

/**
 * Callback type for PNG decoding.
 *
 * Decodes raw PNG data into RGBA pixels. The output pixel data must be
 * allocated through the provided allocator. The library takes ownership
 * of the buffer and will free it with the same allocator.
 *
 * @param userdata  The userdata pointer set via GHOSTTY_SYS_OPT_USERDATA
 * @param allocator The allocator to use for the output pixel buffer
 * @param data      Pointer to the raw PNG data
 * @param data_len  Length of the raw PNG data in bytes
 * @param[out] out  On success, filled with the decoded image
 * @return true on success, false on failure
 */
typedef bool (*GhosttySysDecodePngFn)(
    void* userdata,
    const GhosttyAllocator* allocator,
    const uint8_t* data,
    size_t data_len,
    GhosttySysImage* out);

/**
 * System option identifiers for ghostty_sys_set().
 */
typedef enum {
    /**
     * Set the userdata pointer passed to all sys callbacks.
     *
     * Input type: void* (or NULL)
     */
    GHOSTTY_SYS_OPT_USERDATA = 0,

    /**
     * Set the PNG decode function.
     *
     * When set, the terminal can accept PNG images via the Kitty
     * Graphics Protocol. When cleared (NULL value), PNG decoding is
     * unsupported and PNG image data will be rejected.
     *
     * Input type: GhosttySysDecodePngFn (function pointer, or NULL)
     */
    GHOSTTY_SYS_OPT_DECODE_PNG = 1,
} GhosttySysOption;

/**
 * Set a system-level option.
 *
 * Configures a process-global implementation function. These should be
 * set once at startup before using any terminal functionality that
 * depends on them.
 *
 * @param option The option to set
 * @param value  Pointer to the value (type depends on the option),
 *               or NULL to clear it
 * @return GHOSTTY_SUCCESS on success, GHOSTTY_INVALID_VALUE if the
 *         option is not recognized
 */
GHOSTTY_API GhosttyResult ghostty_sys_set(GhosttySysOption option,
                                           const void* value);

#ifdef __cplusplus
}
#endif

/** @} */

#endif /* GHOSTTY_VT_SYS_H */
