-- Send feedback's optional screenshots (up to 3 per note, Needs improvement only).
-- data is the image after src/screenshots.ts checked it and took out its
-- metadata (EXIF, XMP, text chunks and the like). No file name is kept: a name
-- can say more about the sender than the picture. Deleted with their note, and
-- on their own after 90 days (purgeFeedbackScreenshots in src/retention.ts).

create table feedback_screenshots (
  feedback_id  uuid not null references feedback (id) on delete cascade,
  position     smallint not null check (position between 0 and 2),
  type         text not null check (type in ('image/png', 'image/jpeg')),
  data         bytea not null check (octet_length(data) between 1 and 5242880),
  primary key (feedback_id, position)
);
