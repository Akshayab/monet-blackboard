// Test fixtures. Every browser context gets the scene hook. The `user` fixture makes the default context the owner.
//
// People in a test:
//   newPerson(browser)        the owner, in a separate browser context (there is one owner per install, so every
//                             newPerson is the same person; the name argument only labels the test)
//   newGuest(browser, name)   someone without a session yet; they join by opening a share link (openBoard fills in the
//                             name prompt) or with joinAsGuest(request, name, token). `user.id` is filled in on join.
import { test as base, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';
import { claimOwner, joinAsGuest as apiJoin, type TestUser } from './api';
import { installSceneHook, registerGuest } from './board';
import { BASE_URL } from './env';

export const VIEWPORT = { width: 1600, height: 900 };

export interface Person {
  context: BrowserContext;
  page: Page;
  request: APIRequestContext;
  user: TestUser;
}

async function newContext(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT });
  await installSceneHook(context);
  return context;
}

/** The owner in a separate browser context (own cookies). `label` only names the person in the test. */
export async function newPerson(browser: Browser, label?: string, _prefix?: string): Promise<Person> {
  void label;
  const context = await newContext(browser);
  const user = await claimOwner(context.request);
  const page = await context.newPage();
  return { context, page, request: context.request, user };
}

/** A person with no session yet. They become a guest when they open a share link (see openBoard) or call joinGuest. */
export async function newGuest(browser: Browser, name: string): Promise<Person> {
  const context = await newContext(browser);
  const page = await context.newPage();
  const person: Person = { context, page, request: context.request, user: { id: '', name, kind: 'guest' } };
  registerGuest(page, name, (u) => Object.assign(person.user, u));
  return person;
}

/** Joins a guest through the API with a share link token (no browser navigation). */
export async function joinGuest(person: Person, linkToken: string): Promise<TestUser> {
  const u = await apiJoin(person.request, person.user.name, linkToken);
  Object.assign(person.user, u);
  return person.user;
}

export const test = base.extend<{ user: TestUser }>({
  context: async ({ context }, use) => {
    await installSceneHook(context);
    await use(context);
  },
  user: async ({ context }, use) => {
    await use(await claimOwner(context.request));
  },
});

export { expect };
