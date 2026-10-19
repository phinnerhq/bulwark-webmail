/**
 * Word lists for masked addresses (`<adjective>.<noun>@<domain>`): short,
 * plain-ASCII, unambiguous words that read well together and say nothing
 * about the person behind them. 256 × 256 pairs leave room for collisions to
 * be retried rather than avoided.
 */

export const ADJECTIVES = [
  'able', 'agile', 'airy', 'amber', 'ample', 'apt', 'arctic', 'ardent', 'astral', 'atomic',
  'autumn', 'azure', 'balmy', 'bold', 'brave', 'breezy', 'bright', 'brisk', 'bronze', 'bubbly',
  'busy', 'calm', 'candid', 'carmine', 'cedar', 'cheery', 'chill', 'civic', 'clean', 'clear',
  'clever', 'cloudy', 'cobalt', 'cool', 'copper', 'coral', 'cosmic', 'cozy', 'crafty', 'crimson',
  'crisp', 'curious', 'dainty', 'dapper', 'daring', 'dawn', 'deft', 'delicious', 'dewy', 'direct',
  'dreamy', 'dusky', 'dusty', 'eager', 'early', 'earnest', 'easy', 'electric', 'elegant', 'ember',
  'epic', 'even', 'exact', 'fair', 'fancy', 'fast', 'fearless', 'feisty', 'fern', 'fiery',
  'fine', 'firm', 'fleet', 'floral', 'fluffy', 'fond', 'frank', 'free', 'fresh', 'frosty',
  'gentle', 'giant', 'gilded', 'glad', 'gleaming', 'glossy', 'golden', 'graceful', 'grand', 'granite',
  'green', 'happy', 'hardy', 'hazel', 'hearty', 'heroic', 'hidden', 'honest', 'humble', 'icy',
  'ideal', 'indigo', 'inky', 'ivory', 'jade', 'jolly', 'jovial', 'joyful', 'keen', 'kind',
  'lavish', 'lemon', 'level', 'light', 'lilac', 'limber', 'lively', 'local', 'lofty', 'loyal',
  'lucid', 'lucky', 'lunar', 'lush', 'magic', 'major', 'maple', 'marble', 'mellow', 'merry',
  'mighty', 'mild', 'minty', 'misty', 'modern', 'modest', 'mossy', 'muted', 'neat', 'nimble',
  'noble', 'north', 'novel', 'oaken', 'ocean', 'olive', 'onyx', 'open', 'orange', 'outer',
  'pastel', 'patient', 'peach', 'pearly', 'pebble', 'perky', 'pine', 'placid', 'plain', 'plucky',
  'plush', 'polar', 'polite', 'proper', 'proud', 'pure', 'quick', 'quiet', 'quirky', 'radiant',
  'rapid', 'rare', 'ready', 'regal', 'rosy', 'royal', 'ruby', 'rugged', 'rustic', 'sage',
  'salty', 'sandy', 'scarlet', 'serene', 'shady', 'sharp', 'shiny', 'silent', 'silky', 'silver',
  'simple', 'sleek', 'smooth', 'snowy', 'snug', 'social', 'solar', 'solid', 'sonic', 'spare',
  'spicy', 'spry', 'starry', 'steady', 'stellar', 'stoic', 'stormy', 'sturdy', 'subtle', 'sunny',
  'super', 'swift', 'tame', 'tangy', 'tawny', 'teal', 'tender', 'thrifty', 'tidal', 'tidy',
  'timber', 'tiny', 'topaz', 'tranquil', 'true', 'tulip', 'twilight', 'upbeat', 'urban', 'valiant',
  'velvet', 'verdant', 'vivid', 'warm', 'wavy', 'whimsy', 'wild', 'windy', 'winter', 'wise',
  'witty', 'woody', 'young', 'zany', 'zealous', 'zen', 'zesty', 'zippy', 'bouncy', 'calico',
  'chunky', 'dizzy', 'frugal', 'gusty', 'humid', 'jumbo',
] as const;

export const NOUNS = [
  'acorn', 'anchor', 'antler', 'apple', 'arch', 'atlas', 'aurora', 'badger', 'bamboo', 'banjo',
  'basil', 'bay', 'beacon', 'beam', 'beetle', 'berry', 'birch', 'bison', 'blossom', 'bobcat',
  'boulder', 'breeze', 'brook', 'buffalo', 'butte', 'cactus', 'canyon', 'cape', 'castle', 'cedar',
  'cherry', 'chestnut', 'cinder', 'cliff', 'clover', 'cobble', 'comet', 'compass', 'condor', 'coral',
  'cosmos', 'cove', 'coyote', 'crane', 'crater', 'creek', 'cricket', 'crow', 'crystal', 'cypress',
  'daisy', 'delta', 'desert', 'dingo', 'dolphin', 'dove', 'dragon', 'dune', 'eagle', 'echo',
  'eel', 'elk', 'elm', 'ember', 'falcon', 'fern', 'ferret', 'field', 'finch', 'fjord',
  'flame', 'flint', 'forest', 'fossil', 'fox', 'frost', 'galaxy', 'garden', 'gazelle', 'gecko',
  'geyser', 'ginger', 'glacier', 'glade', 'gopher', 'granite', 'grove', 'gull', 'harbor', 'hare',
  'hawk', 'hazel', 'heath', 'hedge', 'heron', 'hill', 'hollow', 'horizon', 'hornet', 'husky',
  'ibex', 'iris', 'island', 'ivy', 'jackal', 'jaguar', 'jasper', 'jay', 'jetty', 'juniper',
  'kayak', 'kelp', 'kestrel', 'kite', 'koala', 'lagoon', 'lake', 'lantern', 'larch', 'lark',
  'laurel', 'lemur', 'lichen', 'lily', 'linden', 'lion', 'llama', 'locust', 'lotus', 'lynx',
  'magnet', 'magpie', 'mango', 'maple', 'marble', 'marsh', 'meadow', 'meteor', 'mesa', 'mink',
  'mist', 'moose', 'moss', 'moth', 'mountain', 'nebula', 'nectar', 'newt', 'nova', 'oak',
  'oasis', 'ocelot', 'olive', 'orbit', 'orca', 'orchid', 'osprey', 'otter', 'owl', 'panda',
  'panther', 'parrot', 'peak', 'pebble', 'pelican', 'pepper', 'petal', 'pine', 'planet', 'plateau',
  'plover', 'pond', 'poppy', 'prairie', 'puffin', 'puma', 'quail', 'quartz', 'quasar', 'rabbit',
  'raccoon', 'rain', 'raven', 'reef', 'ridge', 'river', 'robin', 'rocket', 'rose', 'saffron',
  'salmon', 'savanna', 'sequoia', 'shadow', 'shore', 'sierra', 'sparrow', 'spruce', 'squid', 'star',
  'stone', 'stork', 'stream', 'summit', 'sun', 'swan', 'thistle', 'thunder', 'tiger', 'timber',
  'toucan', 'trail', 'trout', 'tulip', 'tundra', 'turtle', 'valley', 'violet', 'viper', 'vista',
  'volcano', 'walnut', 'walrus', 'wave', 'willow', 'wolf', 'wren', 'yak', 'yarrow', 'zebra',
  'zephyr', 'bluff', 'cairn', 'dew', 'drift', 'fable', 'grotto', 'inlet', 'isle', 'knoll',
  'moor', 'quill', 'rapids', 'shoal', 'spire', 'tarn', 'thicket', 'wharf', 'wisp', 'yew',
  'aspen', 'beaver', 'canary', 'dahlia', 'egret', 'fawn',
] as const;

/** `random(n)` returns an integer in [0, n). */
export function generateMaskLocalPart(random: (n: number) => number): string {
  return `${ADJECTIVES[random(ADJECTIVES.length)]}.${NOUNS[random(NOUNS.length)]}`;
}
