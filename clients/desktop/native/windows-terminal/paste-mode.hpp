#pragma once
#include <string>
#include <string_view>
#include <array>

// The HWND API has no paste operation or mode getter. Track paste and mouse
// modes for the host clipboard path; screen state and emulation stay in the DLL.
class PasteMode {
  enum class State { ground, escape, csi, string, stringEscape } state_ = State::ground;
  std::u16string parameters_;
  bool osc_ = false;
  std::array<bool, 4> mouse_{};
public:
  bool bracketed = false;
  bool MouseReporting() const { return mouse_[0] || mouse_[1] || mouse_[2] || mouse_[3]; }
  void Feed(std::u16string_view text) {
    for (char16_t ch : text) {
      if (ch == 0x18 || ch == 0x1a) { state_ = State::ground; continue; }
      if (state_ == State::string || state_ == State::stringEscape) {
        if ((state_ == State::stringEscape && ch == u'\\') || ch == 0x9c || (osc_ && ch == 7)) state_ = State::ground;
        else state_ = ch == 0x1b ? State::stringEscape : State::string;
        continue;
      }
      if (ch == 0x1b) { state_ = State::escape; continue; }
      if (ch == 0x9b) { state_ = State::csi; parameters_.clear(); continue; }
      if (ch == 0x9d || ch == 0x90 || ch == 0x98 || ch == 0x9e || ch == 0x9f) { state_ = State::string; osc_ = ch == 0x9d; continue; }
      if (ch < 0x20 || ch == 0x7f) continue;
      if (state_ == State::escape) {
        if (ch == u'[') { state_ = State::csi; parameters_.clear(); }
        else if (ch == u']' || ch == u'P' || ch == u'_' || ch == u'^' || ch == u'X') { state_ = State::string; osc_ = ch == u']'; }
        else { if (ch == u'c') { bracketed = false; mouse_.fill(false); } state_ = State::ground; }
      } else if (state_ == State::csi) {
        if (ch >= 0x40 && ch <= 0x7e) {
          if ((ch == u'h' || ch == u'l') && !parameters_.empty() && parameters_[0] == u'?') {
            size_t start = 1;
            while (start < parameters_.size()) {
              const auto end = parameters_.find(u';', start);
              const auto mode = parameters_.substr(start, end == std::u16string::npos ? end : end - start);
              if (mode == u"2004") bracketed = ch == u'h';
              constexpr std::u16string_view mouseModes[] = {u"9", u"1000", u"1002", u"1003"};
              for (size_t i = 0; i < mouse_.size(); ++i) if (mode == mouseModes[i]) mouse_[i] = ch == u'h';
              if (end == std::u16string::npos) break;
              start = end + 1;
            }
          }
          state_ = State::ground;
        } else if (parameters_.size() < 128) parameters_ += ch;
        else state_ = State::ground;
      }
    }
  }
  std::u16string Prepare(std::u16string_view text) const {
    std::u16string result = bracketed ? u"\x1b[200~" : u"";
    for (size_t i = 0; i < text.size(); ++i) {
      const char16_t ch = text[i];
      // Clipboard text must not inject an early bracketed-paste terminator.
      if (ch == 0x1b || ch == 3) continue;
      if (ch == u'\r' && i + 1 < text.size() && text[i + 1] == u'\n') ++i;
      result += ch == u'\n' ? u'\r' : ch;
    }
    if (bracketed) result += u"\x1b[201~";
    return result;
  }
};
