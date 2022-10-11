
Support batch VAAs in spysdk
Update listener to support batches
Support prometheus 
Emit base metrics 

Test plugin
 - queue up actions for each supported chain, do some blockchain interaction that won't fail

Some unit testing 
Documentation
 - Readme
 - Some code level doc strings
 - Blurb + link from wh docs

Write asset-layer plugin
Create smooth plugin development experience 
- wormhole local validator?
- tilt
  - run plugin_relayer outside tilt but connect to guardian + redis + blockchains in tilt
- library that takes a plugin and enables relaying in-process given a seq number

--
For xHack

Enough tiltnet support that developer can build and run their application in tilt
- Readme
- Basic code documentation
- Cron job hooks - kicks off listener every so often
- DummyPlugin validates use cases
  - Executor 
  - Rest interface


-- 
New Relayer 

Core 
- Make execute push based instead of pull
- Make config easier to use 
- Write install plugin script (or cmd line arg??)

Attestation Plugin
- write it 
- test it

xMint plugin 
- get xMint working locally
- define what needs to happen