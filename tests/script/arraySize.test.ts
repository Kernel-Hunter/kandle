import { describe, expect, it } from 'vitest';
import { MAX_ARRAY_SIZE } from '../../src/script/builtins/core';
import { CANDLES, compile } from './fixtures';

const run = (src: string) => compile(src).run(CANDLES.slice(0, 5));

describe('array size limit', () => {
  it('refuses to create an array larger than the limit', () => {
    const r = run(`indicator("Big")
a = array.new_float(2000000, 0)
plot(array.size(a))`);
    expect(r.error?.message).toMatch(/array\.new_float: an array can hold at most 100,000 elements/);
    expect(r.error?.line).toBe(2);
  });

  it('allows an array of exactly the limit', () => {
    const r = run(`indicator("Edge")
a = array.new<float>(${MAX_ARRAY_SIZE}, 1)
plot(array.sum(a))`);
    expect(r.error).toBeNull();
  });

  it('stops push past the limit', () => {
    const r = run(`indicator("Grow")
var a = array.new_float(${MAX_ARRAY_SIZE}, 0)
array.push(a, 1)
plot(array.size(a))`);
    expect(r.error?.message).toMatch(/array\.push: an array can hold at most/);
  });

  it('finds max and min of a large array', () => {
    const r = compile(`indicator("MaxMin")
a = array.new_float(${MAX_ARRAY_SIZE}, 1)
array.set(a, 70000, 5)
array.set(a, 3, -2)
plot(array.max(a), "max")
plot(array.min(a), "min")`).run(CANDLES.slice(0, 2));
    expect(r.error).toBeNull();
  });
});
