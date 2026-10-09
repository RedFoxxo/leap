# Notices

leap — Copyright (C) 2026 Foxxo.

leap is free software: you can redistribute it and/or modify it under the terms
of the GNU Affero General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version (see [LICENSE](LICENSE)). Versions up to and including 1.0.0 were
released under the MIT License and stay available under it.

## openGym

Parts of leap are ported from [openGym](https://gitlab.com/DuarteSantos8/opengym)
by Duarte Santos (v1.4.0), licensed under the GNU AGPL v3.0 or later, and the
source file in openGym is named next to each port:

- `src/state/stamps.ts`: sync stamping (`frontend/src/lib/sync-merge.js`)
- `src/domain/queue.ts`: rotation, session queue, day notes (`frontend/src/lib/queue.js`,
  `rotation.js`, `history.js`, `day-notes.js`)
- `src/domain/dumbbells.ts`: dumbbell weight meanings (`frontend/src/lib/dumbbells.js`)
- `src/domain/stats.ts`: 1RM formulas (`frontend/src/lib/onerm.js`)
- `src/domain/routine-items.ts`: pyramid rules (`frontend/src/lib/pyramid.js`)
- `data/exercises.json`: the exercise catalogue (`catalogue/exercises/`, below)

openGym — Copyright (C) 2026 Duarte Santos.

## Exercise catalogue

leap ships the text data of openGym's exercise catalogue (ids, names, body
parts, equipment, muscles, categories and instruction steps), generated from
openGym's `catalogue/` at the release recorded in the file's `source` field. The
catalogue is openGym's own and covered by the AGPL, except for the 1,324
entries marked `"textSource": "exercisedb"`, whose names, muscles and
instructions originate from [ExerciseDB v1](https://exercisedb.dev/) by
AscendAPI and reached openGym through
[hasaneyldrm/exercises-dataset](https://github.com/hasaneyldrm/exercises-dataset)
under the MIT License:

```
MIT License

Copyright (c) 2026 Hasan Emir Yıldırım

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation and data files (the "Software"),
to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Exercise media: never included

The exercise pictures and animations in openGym are licensed to openGym by Gym
visual (© Aliaksandr Makatserchyk, gymvisual.com) for use in openGym only. They
are not covered by the AGPL. leap does not include, download or display them.
