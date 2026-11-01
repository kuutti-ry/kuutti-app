# The postal list: source and terms

`postal-areas.generated.ts` here and `apps/api/src/pond/places.generated.ts` are made by `pnpm places` (`scripts/places.ts`, ADR-061 §4) from Statistics Finland's open data. They are not under the repository's licence (`LICENSE`) but under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and Statistics Finland has not endorsed Kuutti or this use of them.

Paavo, open data by postal code area 2026, and Municipalities 2026 (1:4 500 000), Statistics Finland. Downloaded from Statistics Finland's interface service on 31.10.2026, licence CC BY 4.0, https://creativecommons.org/licenses/by/4.0/.

Changed by Kuutti: only the codes, names, municipalities, inhabitants and centre points are used; a municipality's name is cut to one language; a municipality's inhabitants are the sum of its postal areas and its centre their inhabitant-weighted mean; a small area is joined to its municipality, or to the nearest large enough.

Paavo, postinumeroalueittainen avoin tieto 2026, ja Kunnat 2026 (1:4 500 000), Tilastokeskus. Aineisto on ladattu Tilastokeskuksen rajapintapalvelusta 31.10.2026 lisenssillä CC BY 4.0, https://creativecommons.org/licenses/by/4.0/.

Kuutin tekemät muutokset: käytössä ovat vain koodit, nimet, kunnat, asukasluvut ja keskipisteet; kunnan nimi on rajattu yhdelle kielelle; kunnan asukasluku on sen postinumeroalueiden summa ja keskipiste niiden asukasluvuilla painotettu keskiarvo; pieni alue on yhdistetty kuntaansa tai lähimpään riittävän suureen kuntaan.

The layers are `postialue:pno_tilasto_2026` and `tilastointialueet:kunta4500k_2026` of the service at https://geo.stat.fi/geoserver.
