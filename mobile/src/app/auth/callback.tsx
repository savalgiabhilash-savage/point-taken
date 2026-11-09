import { Redirect } from 'expo-router';

// Google sign-in returns to pointtaken://auth/callback. The sign-in form normally catches that link itself;
// if the OS opens it as a page instead (some Android browsers), just go home, where the session listener
// shows the team once the sign-in finishes.
export default function AuthCallback() {
  return <Redirect href="/" />;
}
