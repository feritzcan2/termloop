#!/usr/bin/env bash
# pbxproj-add-file.sh — register a Swift file in GhosttyTabs.xcodeproj
# Usage: scripts/pbxproj-add-file.sh <relative-path-to-.swift> <target-name>
# Example: scripts/pbxproj-add-file.sh Sources/TermLoop/UI/Sidebar/TermLoopSidebarTab.swift cmux
set -euo pipefail

FILE_PATH="${1:?Usage: $0 <relative-path-to-.swift> <target-name>}"
TARGET_NAME="${2:?Usage: $0 <relative-path-to-.swift> <target-name>}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${REPO_ROOT}/GhosttyTabs.xcodeproj"

ruby -r xcodeproj -e '
  project = Xcodeproj::Project.open(ARGV[0])
  target = project.targets.find { |t| t.name == ARGV[1] }
  raise "target not found: #{ARGV[1]}" unless target
  file_path = ARGV[2]
  if target.source_build_phase.files_references.any? { |f| f.path == file_path || f.real_path.to_s.end_with?(file_path) }
    puts "already registered: #{file_path}"
    exit 0
  end
  # Mirror filesystem hierarchy in the project group tree.
  group_path = File.dirname(file_path)
  group = project.main_group
  group_path.split("/").each do |segment|
    next if segment == "."
    sub = group.children.find { |c| c.display_name == segment && c.is_a?(Xcodeproj::Project::Object::PBXGroup) }
    sub ||= group.new_group(segment, segment)
    group = sub
  end
  file_ref = group.new_file(File.basename(file_path))
  target.add_file_references([file_ref])
  project.save
  puts "registered: #{file_path} -> #{ARGV[1]}"
' "$PROJECT" "$TARGET_NAME" "$FILE_PATH"
