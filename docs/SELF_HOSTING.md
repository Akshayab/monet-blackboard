# Self-hosting

Everything Monet Blackboard keeps is in PostgreSQL: boards, uploaded images, docs and decks, chat history, people,
sessions and AI usage. The app itself is stateless, so backing up means backing up the database.

## Back up

With Docker Compose:

```sh
docker compose exec -T db pg_dump -U monet -Fc monet > monet-$(date +%F).dump
```

From source, use your own `DATABASE_URL`:

```sh
pg_dump -Fc "$DATABASE_URL" > monet-$(date +%F).dump
```

Keep backups private. They hold every board, the owner link token and live session ids.

## Restore

Stop the app first so nothing writes while you restore, then restore into an empty database:

```sh
docker compose stop monet
docker compose exec -T db dropdb -U monet monet
docker compose exec -T db createdb -U monet monet
docker compose exec -T db pg_restore -U monet -d monet --no-owner < monet-2027-01-31.dump
docker compose start monet
```

From source, run the same `dropdb`, `createdb` and `pg_restore` commands against your server, then start the app.

## Upgrade

1. Back up (above).
2. Read [CHANGELOG.md](../CHANGELOG.md) for the releases between your version and the new one.
3. Get the new code and restart:

   ```sh
   git pull
   docker compose up -d --build
   ```

   From source: `git pull`, `pnpm install --frozen-lockfile`, `pnpm build`, then `NODE_ENV=production pnpm start`.

The server applies pending database migrations when it starts, before it accepts requests. Migrations only move
forward; to go back to an older version, restore the backup you made before upgrading.

## Move to another machine

Back up on the old machine, copy the dump and your `.env`, restore on the new one, and start the app. The owner link
and everyone's sessions carry over. In team mode, set `PUBLIC_URL` if the address changes.

## Start over

`docker compose down -v` deletes the database volume and everything in it. There is no undo.
