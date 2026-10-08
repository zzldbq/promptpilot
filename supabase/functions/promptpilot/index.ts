import {createHandler} from './main.mjs';
Deno.serve(createHandler((name: string) => Deno.env.get(name)));
