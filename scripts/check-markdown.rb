#!/usr/bin/env ruby
# frozen_string_literal: true

# Markdown gate for tracked *.md / *.mdx files, run by `make check`:
#   - relative links and images resolve to a file or directory in this
#     repository (external URLs, in-page anchors and site-absolute paths such
#     as `/docs/x` are not checked);
#   - no retired or fabricated doc fingerprints come back.
# Usage: ruby scripts/check-markdown.rb [path-prefix ...]

require "uri"

FINGERPRINTS = [
  /app-mindburn-web\.org/i,
  /svc-titan-proofd/,
  /Rollback Class R[0-9]/,
  /sovereign microservice/i,
  /HELM Notary/,
  %r{Prometheus\s+:2112/metrics}i,
  /OTel\s+:4317/i
].freeze

LINK = /!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/
REFERENCE = /^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/
HTML_REF = /<(?:a|img|source)\b[^>\n]*?\b(?:href|src)\s*=\s*"([^"\n]*)"/i

root = Dir.pwd
prefixes = ARGV
files = IO.popen(%w[git ls-files -z -- *.md *.mdx], &:read).split("\0")
files = files.select { |f| prefixes.empty? || prefixes.any? { |p| f.start_with?(p) } }
problems = []

files.each do |file|
  text = File.read(file, encoding: "UTF-8").scrub("")
  in_fence = nil
  text.each_line.with_index(1) do |line, number|
    FINGERPRINTS.each do |pattern|
      problems << "#{file}:#{number}: banned doc fingerprint #{pattern.source}" if line.match?(pattern)
    end

    if (fence = line[/^\s{0,3}(`{3,}|~{3,})/, 1])
      if in_fence.nil?
        in_fence = fence
      elsif fence[0] == in_fence[0] && fence.length >= in_fence.length
        in_fence = nil
      end
      next
    end
    next if in_fence

    prose = line.gsub(/(`+).*?\1/, "")
    targets = prose.scan(LINK).flatten + prose.scan(REFERENCE).flatten + prose.scan(HTML_REF).flatten
    targets.each do |raw|
      target = raw.delete_prefix("<").delete_suffix(">").strip
      next if target.empty? || target.start_with?("#", "/") || target.match?(/\A[a-z][a-z0-9+.-]*:/i)

      path = URI.decode_www_form_component(target.sub(/[?#].*\z/m, "").gsub("+", "%2B"))
      next if path.empty?

      resolved = File.expand_path(path, File.dirname(File.join(root, file)))
      if !resolved.start_with?("#{root}/") && resolved != root
        problems << "#{file}:#{number}: link leaves the repository: #{target}"
      elsif !File.exist?(resolved)
        problems << "#{file}:#{number}: broken relative link: #{target}"
      end
    end
  end
end

if problems.empty?
  puts "markdown: #{files.length} files, relative links resolve, no banned fingerprints"
else
  warn problems
  warn "markdown: #{problems.length} problem(s)"
  exit 1
end
