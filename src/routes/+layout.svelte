<script lang="ts">
  import '../styles/app.css';
  let { children } = $props();
</script>

<svelte:head>
  <title>Work Times</title>
  <meta
    name="description"
    content="A private WakaTime archive and work-classification assistant."
  />
</svelte:head>

{@render children()}
