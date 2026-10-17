#!/usr/bin/env ruby
# A small Cloud Logging query-language checker for the filters Terraform composes (monitoring.tf, analytics.tf).
#
#   ruby logfilter.rb lint '<filter>'                 exit 0 if the filter is well formed AND no parenthesised group (or the top level)
#                                                     mixes AND with OR directly, i.e. it does not rely on operator precedence
#   ruby logfilter.rb eval '<filter>' '<entry json>'  prints true or false, using Google's precedence: NOT, then OR, then AND
#                                                     ("NOT has the highest precedence, followed by OR and AND":
#                                                     cloud.google.com/logging/docs/view/logging-query-language)
#
# Supported: field = / != / =~ / !~ / : / > / >= / < / <= value (quoted string or bare word), AND, OR, NOT, parentheses. The point is
# the structure, not the whole language. The tests use it to prove that an `a AND b OR c AND d` filter (which Logging reads as
# `a AND (b OR c) AND d`) cannot slip back into monitoring.tf.
require 'json'

class Lex
  OPS = ['>=', '<=', '!=', '=~', '!~', '=', '>', '<', ':'].freeze
  def self.tokens(src)
    out = []; i = 0
    while i < src.length
      c = src[i]
      if c =~ /\s/ then i += 1
      elsif c == '(' || c == ')' then out << [c, c]; i += 1
      elsif c == '"'
        j = i + 1; buf = +''
        while j < src.length && src[j] != '"'
          if src[j] == '\\' && j + 1 < src.length then buf << src[j + 1]; j += 2 else buf << src[j]; j += 1 end
        end
        raise 'unterminated string' if j >= src.length
        out << [:str, buf]; i = j + 1
      elsif (op = OPS.find { |o| src[i, o.length] == o }) then out << [:op, op]; i += op.length
      else
        j = i
        j += 1 while j < src.length && src[j] !~ /[\s()"=!<>:~]/
        raise "unexpected character #{c.inspect}" if j == i
        w = src[i...j]
        out << (%w[AND OR NOT].include?(w) ? [w, w] : [:word, w]); i = j
      end
    end
    out
  end
end

# Returns nil when the filter is fine, else a message.
def lint(src)
  toks = Lex.tokens(src)
  stack = [[]]
  toks.each do |t, _|
    case t
    when '(' then stack << []
    when ')'
      return 'unbalanced )' if stack.length == 1
      g = stack.pop
      return "a parenthesised group mixes AND and OR: #{g.inspect}" if g.uniq.length > 1
    when 'AND', 'OR' then stack.last << t
    end
  end
  return 'unbalanced (' if stack.length != 1
  return 'top level mixes AND and OR' if stack[0].uniq.length > 1
  Lex.tokens(src) && (parse(toks) && nil)
rescue StandardError => e
  e.message
end

# ---- parser (Google precedence: NOT > OR > AND) ----
def parse(toks)
  pos = 0
  peek = -> { toks[pos] }
  take = -> { t = toks[pos]; pos += 1; t }
  parse_and = nil; parse_or = nil; parse_not = nil
  primary = lambda do
    t = take.call
    raise 'unexpected end of filter' if t.nil?
    if t[0] == '('
      e = parse_and.call
      raise 'missing )' unless take.call&.first == ')'
      e
    elsif t[0] == :word || t[0] == :str
      op = take.call
      raise "expected an operator after #{t[1]}" unless op && op[0] == :op
      v = take.call
      raise "expected a value after #{op[1]}" unless v && [:word, :str].include?(v[0])
      [:cmp, t[1], op[1], v[1]]
    else raise "unexpected #{t[1]}"
    end
  end
  parse_not = lambda do
    if peek.call&.first == 'NOT' then take.call; [:not, parse_not.call] else primary.call end
  end
  parse_or = lambda do
    xs = [parse_not.call]
    while peek.call&.first == 'OR' do take.call; xs << parse_not.call end
    xs.length == 1 ? xs[0] : [:or, xs]
  end
  parse_and = lambda do
    xs = [parse_or.call]
    while peek.call&.first == 'AND' do take.call; xs << parse_or.call end
    xs.length == 1 ? xs[0] : [:and, xs]
  end
  ast = parse_and.call
  raise "unexpected #{peek.call[1]}" if peek.call
  ast
end

SEV = %w[DEFAULT DEBUG INFO NOTICE WARNING ERROR CRITICAL ALERT EMERGENCY].freeze

def fetch(entry, path)
  path.split('.').reduce(entry) { |h, k| h.is_a?(Hash) ? h[k] : nil }
end

def evaluate(ast, entry)
  case ast[0]
  when :and then ast[1].all? { |a| evaluate(a, entry) }
  when :or then ast[1].any? { |a| evaluate(a, entry) }
  when :not then !evaluate(ast[1], entry)
  when :cmp
    _, field, op, want = ast
    got = fetch(entry, field)
    return false if got.nil?
    return SEV.index(got.to_s).to_i.send(op == '=' ? :== : op.to_sym, SEV.index(want).to_i) if field == 'severity' && %w[= > >= < <=].include?(op) && SEV.include?(want)
    case op
    when '=' then got.to_s == want
    when '!=' then got.to_s != want
    when '=~' then Regexp.new(want).match?(got.to_s)
    when '!~' then !Regexp.new(want).match?(got.to_s)
    when ':' then got.to_s.downcase.include?(want.downcase)
    else
      a = Float(got) rescue nil; b = Float(want) rescue nil
      a && b ? a.send(op.to_sym, b) : false
    end
  end
end

cmd, filter, entry = ARGV
case cmd
when 'lint'
  msg = lint(filter)
  if msg then warn msg; exit 1 end
  exit 0
when 'eval'
  puts evaluate(parse(Lex.tokens(filter)), JSON.parse(entry))
else
  warn 'usage: logfilter.rb lint FILTER | eval FILTER ENTRY_JSON'; exit 2
end
