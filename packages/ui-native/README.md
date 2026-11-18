# @ebalangay/ui-native

Shared React Native components (NativeWind 4, light + dark, 44px touch targets). Every user-facing string is a prop — pass `t(...)` from `@ebalangay/i18n/react`.

## App setup (Expo SDK 58)

1. `tailwind.config.js`:
   ```js
   import preset from '@ebalangay/ui-native/tailwind-preset';
   export default {
     presets: [preset],
     content: [
       './app/**/*.{ts,tsx}',
       './src/**/*.{ts,tsx}',
       '../../packages/ui-native/dist/**/*.js',
     ],
   };
   ```
2. NativeWind babel/metro setup per the NativeWind 4 docs (`global.css`, `withNativeWind`).
3. `nativewind-env.d.ts` with `/// <reference types="nativewind/types" />`, and in `tsconfig.json`:
   `"customConditions": ["react-native-legacy-deep-imports"]` (RN 0.88's strict types can't be augmented with `className`).
4. Wrap the root in `<ToastProvider>`.

`OfflineBanner` takes an `offline` prop: feed it from `useSocketConnected()` or your own connectivity hook.
