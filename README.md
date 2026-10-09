# Saints Forge

An EVE Frontier ship-fitting tool, made by The Saints. Fit a Reiver or a LAI module by module on the hull grid, exactly
as the game's fitting window lays it out, and see the numbers that matter before you undock: hold, fuel and how many
hours it lasts, capacitor and whether it stays charged with everything running, hull HP and repair, damage, power.
**Forge for the role** fills the spare cells by your priorities (hold, capacitor, fuel, armour, repair) and never
removes what you placed. A proposal link carries the whole fit; paste it in Discord.

Open it: https://saints-frontier.github.io/forge/

Everything runs in your browser; nothing is uploaded. The solver uses one CPU core for the seconds you set.

Numbers come from the game client's own data (module footprints, hull grids) plus measured curves for capacitor
recharge and fuel burn (marked *est*). Found a wrong number? Open an issue with a screenshot.

Built from the Saints' toolkit (`tools/build_forge_public.py`). Not affiliated with CCP Games.
