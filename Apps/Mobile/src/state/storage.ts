import AsyncStorage from '@react-native-async-storage/async-storage';
import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/** AsyncStorage works on iOS, Android and web (localStorage). Failures never throw into UI. */
const safeStorage: StateStorage = {
  getItem: async (name) => {
    try {
      return await AsyncStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      await AsyncStorage.setItem(name, value);
    } catch {
      // Preferences are conveniences; losing a write is not fatal.
    }
  },
  removeItem: async (name) => {
    try {
      await AsyncStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};

export const persistStorage = createJSONStorage(() => safeStorage);
