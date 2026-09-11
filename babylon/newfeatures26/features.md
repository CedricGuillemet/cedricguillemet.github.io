
\- PCG tools :  scattering, fast scene creation. define rules (yet another editor or more features of NGE) and apply these rules. like 'instanciate these mesh with a raycast if normal.y > threshold'. Add physics, particles,... spline edit (see https://babylonjs.com/lite-demos/demo-antigravity-racer.html track spline editor)

output: NGE extension or custom tool + runtime
impact: 1/5 Limited traction

\- AI-first content browser (asset source browser and scene creation tool). Start by prompting a complete scene, then iterate with AI and tweak the result using standard selection, placement, and gizmo tools. Have asset sources (Babylon, asset packs, community libraries, local folders) to keep generation coherent. Create and refine a kitbashed scene (add environment, meshes, probes, and scripts) while keeping creators in control. Use `html/assets/scene-builder.png`, `html/assets/asset-pack-picker.png`, and `html/assets/environment-probes.png`.

output: inspector extension
impact: 2/5 expect more scenes to be made.

\- mesh destruction editor/preview (setup rules for destruction, apply at runtime). fruit ninja, cut walking character, ... core principle is to duplicate a clipped mesh while keeping some attributes. easy to produce fun and impactful demos https://babylonjs.com/lite-demos/demo-break-meshes.html. Use `html/assets/destruction-preview.png` as the main visual and keep the Fruit Ninja gif.

output: runtime + demo examples
impact: 3/5 Demo fun to play with. Nice integration in community games

\- physics rig editor (mix animation and physicalized bones): tails, hair strand, backpack. make animations more dynamic
For characters but also cars. Full or partial rig (only rig a bunch of bones)
Can this be used for robotics display?
output: editor and gltf/.Babylon output.
use `html/assets/physicsRigEdit.webp`
impact: 3/5

\- neural textures compression. learn machine learning math. I'm sure some middleware will be available soon. make a few tests, get a report and start conversation with the community. https://www.ubisoft.com/fr-fr/news/ignt.58488/shipping-neural-texture-compression-in-assassin-s-creed-mirage%22 . add explanation on what is a neural texture

output: CLI + light JS decoder
impact: 3.5/5 Better compressed texture. Be competent is AI tech/models.

\- Virtual geometry (Nanite).
 Use `html/assets/meshlets.png`
1 CLI tool to convert to data that can be streamed. runtime to stream and display geometry.
impact: 4/5 Ease mesh display on the web. Allows very complex geometry to be processed (OneDrive, viewer)