import { acceptRegistration } from './client';

export function provideAuthRegistration({ firstName, lastName }: { firstName: string; lastName: string }) {
  void acceptRegistration(firstName, lastName);
}

export function restartAuth() {
  // The phrase screen has no server-side step to restart
}
