import { Redirect } from 'expo-router';

/** An unknown link (or a host path on web) opens the Cameras home instead of a dead end. */
export default function NotFound() {
  return <Redirect href="/" />;
}
