import { describe, expect, it } from 'vitest';
import { joinsByItself, prefillFromHome, stationJoinArgs } from './homeWifi';

const kept = { ssid: 'Home', hasPassword: true };

describe('the kept home Wi-Fi', () => {
  it('joins by itself only when a password is kept for that network', () => {
    expect(joinsByItself(kept, 'Home')).toBe(true);
    expect(joinsByItself(kept, ' Home ')).toBe(true);
    expect(joinsByItself(kept, 'Office')).toBe(false);
    expect(joinsByItself({ ssid: 'Home', hasPassword: false }, 'Home')).toBe(false);
    expect(joinsByItself(null, 'Home')).toBe(false);
  });

  it('prefills an empty network name and leaves a typed one alone', () => {
    expect(prefillFromHome({ ssid: '', password: '' }, kept)).toEqual({ ssid: 'Home', password: '' });
    expect(prefillFromHome({ ssid: 'Office', password: '' }, kept)).toEqual({ ssid: 'Office', password: '' });
    expect(prefillFromHome({ ssid: '', password: '' }, null)).toEqual({ ssid: '', password: '' });
  });

  it('sends no password for the kept network, and what was typed otherwise', () => {
    const base = { address: 'AA:BB', home: kept, remember: true, model: 0x20 };
    expect(stationJoinArgs({ ...base, ssid: 'Home', typed: undefined })).toEqual({ address: 'AA:BB', ssid: 'Home', remember: true, model: 0x20 });
    expect(stationJoinArgs({ ...base, ssid: 'Home', typed: '' })).not.toHaveProperty('password');
    expect(stationJoinArgs({ ...base, ssid: 'Home', typed: 'new-secret' })).toMatchObject({ password: 'new-secret' });
    // An open network, or one this PC keeps nothing for: an empty password, as typed.
    expect(stationJoinArgs({ ...base, ssid: 'Cafe', typed: undefined })).toMatchObject({ password: '' });
    expect(stationJoinArgs({ ...base, home: null, ssid: 'Home', typed: '', remember: false })).toEqual({
      address: 'AA:BB',
      ssid: 'Home',
      password: '',
      remember: false,
      model: 0x20,
    });
  });
});
